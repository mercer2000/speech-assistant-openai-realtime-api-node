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

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
fastify.post('/incoming-call', async (request, reply) => {
    console.log('Received incoming call webhook');
    const { To: toNumber, From: fromNumber, CallSid: callSid } = request.body;

    if (!toNumber) {
        console.error('No "To" number provided in the request body');
        return reply.code(400).send('Bad Request: Missing To number');
    }

    console.log(`Incoming call to number: ${toNumber} from ${fromNumber}, CallSid: ${callSid}`);

    try {
        const phoneData = await fetchPhoneData(toNumber);
        const promptData = await fetchPromptData(phoneData.tenant_id);
        await storeSystemPrompt(callSid, promptData.prompt_text);

        const twimlResponse = generateTwimlResponse(request.hostname, callSid);
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
async function fetchPhoneData(toNumber) {
    const { data, error } = await supabase
        .from('phone_numbers')
        .select('tenant_id')
        .eq('phone_number', toNumber)
        .limit(1)
        .single();

    if (error) throw new Error(`Error fetching tenant_id: ${error.message}`);
    if (!data) throw new Error('No phone data found');
    return data;
}

async function fetchPromptData(tenantId) {
    const { data, error } = await supabase
        .from('prompts')
        .select('prompt_text')
        .eq('tenant_id', tenantId)
        .limit(1)
        .single();

    if (error) throw new Error(`Error fetching prompt: ${error.message}`);
    if (!data) throw new Error('No prompt data found');
    return data;
}

async function storeSystemPrompt(callSid, systemPrompt) {
    await redisClient.set(`prompt:${callSid}`, systemPrompt, { EX: 3600 }); // Expires in 1 hour
}

function generateTwimlResponse(hostname, callSid) {
    return `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say>Hello, how can I help you?</Say>
                <Connect>
                    <Stream url="wss://${hostname}/media-stream?callSid=${encodeURIComponent(callSid)}"/>
                </Connect>
            </Response>`;
}

function extractCallSid(req) {
    // Try to get callSid from query parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const callSid = url.searchParams.get('callSid');
    if (callSid) return callSid;

    // If not in query params, check Sec-WebSocket-Protocol header
    if (req.headers['sec-websocket-protocol']) {
        const protocols = req.headers['sec-websocket-protocol'].split(',');
        const callSidProtocol = protocols.find(p => p.trim().startsWith('callSid='));
        if (callSidProtocol) {
            return callSidProtocol.split('=')[1];
        }
    }

    console.error('CallSid not found in query parameters or Sec-WebSocket-Protocol header');
    console.log('Request headers:', req.headers);
    console.log('Request URL:', req.url);
    
    return null;
}

function handleWebSocketConnection(connection, req) {
    console.log('WebSocket client connected');
    console.log('Request URL:', req.url);
    console.log('Request headers:', req.headers);
    
    const callSid = extractCallSid(req);
    if (!callSid) {
        console.error('No "callSid" provided');
        connection.socket.send(JSON.stringify({ error: 'No callSid provided' }));
        return connection.socket.close();
    }

    console.log(`WebSocket connection initiated for CallSid: ${callSid}`);

    setupOpenAIWebSocket(connection, callSid);
}

function extractCallSid(req) {
    // Try to get callSid from query parameters
    const urlParts = req.url.split('?');
    if (urlParts.length > 1) {
        const queryParams = new URLSearchParams(urlParts[1]);
        const callSid = queryParams.get('callSid');
        if (callSid) return callSid;
    }

    // If not in query params, check Sec-WebSocket-Protocol header
    if (req.headers['sec-websocket-protocol']) {
        const protocols = req.headers['sec-websocket-protocol'].split(',');
        const callSidProtocol = protocols.find(p => p.trim().startsWith('callSid='));
        if (callSidProtocol) {
            return callSidProtocol.split('=')[1];
        }
    }

    return null;
}

async function setupOpenAIWebSocket(connection, callSid) {
    const SYSTEM_MESSAGE = await redisClient.get(`prompt:${callSid}`);
    if (!SYSTEM_MESSAGE) {
        console.error(`No system prompt found for CallSid: ${callSid}`);
        connection.socket.send(JSON.stringify({ error: 'No system prompt found' }));
        return connection.socket.close();
    }

    console.log(`Retrieved SYSTEM_MESSAGE for CallSid ${callSid}: ${SYSTEM_MESSAGE}`);

    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    let streamSid = null;

    openAiWs.on('open', () => {
        console.log('Connected to the OpenAI Realtime API');
        setTimeout(() => sendSessionUpdate(openAiWs, SYSTEM_MESSAGE), 250);
    });

    openAiWs.on('message', (data) => handleOpenAIMessage(data, connection, streamSid));

    connection.socket.on('message', (message) => handleTwilioMessage(message, openAiWs, streamSid));

    connection.socket.on('close', async () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        await redisClient.del(`prompt:${callSid}`);
        console.log(`WebSocket closed for CallSid: ${callSid}`);
    });

    openAiWs.on('close', () => console.log('Disconnected from the OpenAI Realtime API'));
    openAiWs.on('error', (error) => console.error('Error in the OpenAI WebSocket:', error));
}

function sendSessionUpdate(openAiWs, SYSTEM_MESSAGE) {
    const sessionUpdate = {
        type: 'session.update',
        session: {
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: VOICE,
            instructions: SYSTEM_MESSAGE,
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