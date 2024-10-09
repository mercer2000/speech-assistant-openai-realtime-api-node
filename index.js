// Import necessary modules and initialize Fastify and Express
import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import express from 'express';
import { createClient } from '@supabase/supabase-js'; // Import Supabase client

// Load environment variables
dotenv.config();

const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY } = process.env;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing necessary environment variables. Please set them in the .env file.');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// List of Event Types to log
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Function to get dynamic prompt by phone number
async function getPromptByPhoneNumber(toPhoneNumber) {

    console.log('Fetching prompt for phone number:', toPhoneNumber);
    if (!toPhoneNumber) {
        console.error('No phone number provided.');
        return null;
    }
    // Step 1: Fetch tenant_id from phone_numbers table
    const { data: phoneNumberData, error: phoneNumberError } = await supabase
        .from('phone_numbers')
        .select('tenant_id')
        .eq('phone_number', toPhoneNumber)
        .single();

    if (phoneNumberError || !phoneNumberData) {
        console.error('Error fetching tenant_id:', phoneNumberError);
        return null;
    }

    const tenantId = phoneNumberData.tenant_id;

    // Step 2: Fetch the prompt from prompts table using tenant_id
    const { data: promptData, error: promptError } = await supabase
        .from('prompts')
        .select('prompt_text')
        .eq('tenant_id', tenantId)
        .single();

    if (promptError || !promptData) {
        console.error('Error fetching prompt_text:', promptError);
        return null;
    }

    return promptData.prompt_text;
}

// Server start listener
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// Root route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio incoming/outgoing calls
fastify.all('/incoming-call', async (request, reply) => {
    const toPhoneNumber = request.body.To || request.query.To; // Get the TO phone number from the request

    // Dynamically fetch the prompt based on the incoming TO phone number
    const systemMessage = await getPromptByPhoneNumber(toPhoneNumber) || 'You are a helpful and bubbly AI assistant...'; // Fallback to default message if not found

    console.log('System message:', systemMessage);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Hello, how can I help you.</Say>                             
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream?message=${encodeURIComponent(systemMessage)}" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Parse the system message from the query string
        const systemMessage = decodeURIComponent(req.query.message) || 'You are a helpful and bubbly AI assistant...';

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        // Function to send session update
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: systemMessage, // Use dynamic system message here
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // OpenAI WebSocket "open" event
        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250);
        });

        // Handle messages from OpenAI WebSocket
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // Handle session updates
                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                // Handle audio delta and transcription events
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }

                // Detect "GOODBYE" in text responses
                if (response.type === 'response.content' && response.content) {
                    const textResponse = response.content;
                    console.log('Text response:', textResponse);

                    // If "GOODBYE" is detected, hang up the call
                    if (textResponse.toLowerCase().includes('goodbye')) {
                        console.log('Goodbye detected, ending the call...');
                        const hangupResponse = `<?xml version="1.0" encoding="UTF-8"?>
                                                <Response>
                                                    <Hangup/>
                                                </Response>`;
                        connection.send(hangupResponse);
                    }
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
                        console.log('Incoming stream started', streamSid);
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

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
