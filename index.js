import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';
import { createClient as createRedisClient } from 'redis';

// Load environment variables from .env file
dotenv.config();

// Retrieve and validate environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY', 'REDIS_URL'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
    console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY, REDIS_URL } = process.env;

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const redisClient = createRedisClient({ url: REDIS_URL });
redisClient.connect().catch(console.error);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Fallback SYSTEM_MESSAGE in case database fetch fails
const FALLBACK_SYSTEM_MESSAGE = 'You are a helpful AI assistant.';

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Received incoming call webhook');
    const { To: toNumber, From: fromNumber, CallSid: callSid } = request.body;

    console.log(`Incoming call to number: ${toNumber} from ${fromNumber}, CallSid: ${callSid}`);

    try {
        const twimlResponse = generateTwimlResponse(request.headers.host);
        return reply.type('text/xml').send(twimlResponse);
    } catch (error) {
        console.error('Error processing incoming call:', error);
        return reply.code(500).send('Internal Server Error');
    }
});

// WebSocket route for media streaming
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, handleWebSocketConnection);
});

// Helper functions
function generateTwimlResponse(hostname) {
    return `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                <Pause length="1"/>
                <Say>O.K. you can start talking!</Say>
                <Connect>
                    <Stream url="wss://${hostname}/media-stream" />
                </Connect>
            </Response>`;
}

async function handleWebSocketConnection(connection, req) {
    console.log('Client connected');

    try {
        const systemMessage = await fetchSystemMessage() || FALLBACK_SYSTEM_MESSAGE;
        setupOpenAIWebSocket(connection, systemMessage);
    } catch (error) {
        console.error('Error setting up WebSocket connection:', error);
        if (connection.socket && connection.socket.close) {
            connection.socket.close();
        }
    }
}


async function fetchSystemMessage() {
    try {
        const { data, error } = await supabase
            .from('prompts')
            .select('prompt_text')
            .limit(1)
            .single();

        if (error) throw error;
        return data?.prompt_text;
    } catch (error) {
        console.error('Error fetching system message:', error);
        return null;
    }
}

function setupOpenAIWebSocket(connection, systemMessage) {
    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    let streamSid = null;

    openAiWs.on('open', () => {
        console.log('Connected to the OpenAI Realtime API');
        setTimeout(() => sendSessionUpdate(openAiWs, systemMessage), 250);
    });

    openAiWs.on('message', (data) => handleOpenAIMessage(data, connection, streamSid));

    if (connection.socket) {
        connection.socket.on('message', (message) => handleTwilioMessage(message, openAiWs, streamSid));

        connection.socket.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });
    } else {
        console.error('Connection socket is undefined');
    }

    openAiWs.on('close', () => console.log('Disconnected from the OpenAI Realtime API'));
    openAiWs.on('error', (error) => console.error('Error in the OpenAI WebSocket:', error));
}

function sendSessionUpdate(openAiWs, systemMessage) {
    const sessionUpdate = {
        type: 'session.update',
        session: {
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: VOICE,
            instructions: systemMessage,
            modalities: ["text", "audio"],
            temperature: 0.8,
        }
    };

    console.log('Sending session update:', JSON.stringify(sessionUpdate));
    openAiWs.send(JSON.stringify(sessionUpdate));
}

function handleOpenAIMessage(data, connection, streamSid) {
    try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
            console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === 'session.updated') {
            console.log('Session updated successfully:', response);
        }

        if (response.type === 'response.audio.delta' && response.delta) {
            const audioDelta = {
                event: 'media',
                streamSid: streamSid,
                media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
            };
            connection.socket.send(JSON.stringify(audioDelta));
        }
    } catch (error) {
        console.error('Error processing OpenAI message:', error, 'Raw message:', data);
    }
}

function handleTwilioMessage(message, openAiWs, streamSid) {
    try {
        const data = JSON.parse(message);

        switch (data.event) {
            case 'media':
                if (openAiWs.readyState === WebSocket.OPEN) {
                    const audioAppend = {
                        type: 'input_audio_buffer.append',
                        audio: data.media.payload
                    };
                    openAiWs.send(JSON.stringify(audioAppend));
                }
                break;
            case 'start':
                streamSid = data.start.streamSid;
                console.log('Incoming stream has started', streamSid);
                break;
            default:
                console.log('Received non-media event:', data.event);
                break;
        }
    } catch (error) {
        console.error('Error parsing message:', error, 'Message:', message);
    }
}

// Start the server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    await redisClient.quit();
    process.exit(0);
});