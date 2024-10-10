import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_KEY in the .env file.');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console
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
fastify.all('/incoming-call', async (request, reply) => {
    const toNumber = request.body.To;
    console.log(`Incoming call to number: ${toNumber}`);
    console.log(`Request host: ${request.headers.host}`);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                             
                              <Say>Hello, how can I help you?</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream?to=${encodeURIComponent(toNumber)}" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
        console.log('Client connected');

        // Extract 'to' from query parameters
        const toNumber = req.query.to;
        console.log(`WebSocket connection initiated for number: ${toNumber}`);

        // Fetch tenant_id from phone_numbers table
        const { data: phoneData, error: phoneError } = await supabase
            .from('phone_numbers')
            .select('tenant_id')
            .eq('phone_number', toNumber)
            .limit(1)
            .single();

        if (phoneError || !phoneData) {
            console.error('Error fetching tenant_id from phone_numbers:', phoneError || 'No data returned');
            // Close connection if tenant_id is not found
            connection.socket.close();
            return;
        }

        const tenantId = phoneData.tenant_id;
        console.log(`Found tenant_id: ${tenantId} for phone number: ${toNumber}`);

        // Fetch prompt_text from prompts table
        const { data: promptData, error: promptError } = await supabase
            .from('prompts')
            .select('prompt_text')
            .eq('tenant_id', tenantId)
            .limit(1)
            .single();

        if (promptError || !promptData) {
            console.error('Error fetching prompt from prompts table:', promptError || 'No data returned');
            // Close connection if prompt is not found
            connection.socket.close();
            return;
        }

        const SYSTEM_MESSAGE = promptData.prompt_text;
        console.log(`Retrieved SYSTEM_MESSAGE for tenant_id ${tenantId}: ${SYSTEM_MESSAGE}`);

        // OpenAI WebSocket connection
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        const sendSessionUpdate = () => {
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
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability
        });

        // Listen for messages from the OpenAI WebSocket
        openAiWs.on('message', (data) => {
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
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
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
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle OpenAI WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Start the server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
