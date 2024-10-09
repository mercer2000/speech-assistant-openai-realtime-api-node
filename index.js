// Import necessary modules and initialize Fastify
import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient as createRedisClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY, REDIS_URL } = process.env;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY || !REDIS_URL) {
    console.error('Missing necessary environment variables. Please set them in the .env file.');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_KEY);

// Initialize Redis client
const redisClient = createRedisClient({
    url: REDIS_URL || 'redis://red-cs3glllumphs738t7c30:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

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

    if (phoneNumberError) {
        console.error('Error fetching tenant_id:', phoneNumberError);
        return null;
    }

    if (!phoneNumberData) {
        console.log('No matching phone number found in database');
        return null;
    }

    const tenantId = phoneNumberData.tenant_id;
    console.log('Found tenant_id:', tenantId);

    // Step 2: Fetch the prompt from prompts table using tenant_id
    const { data: promptData, error: promptError } = await supabase
        .from('prompts')
        .select('prompt_text')
        .eq('tenant_id', tenantId)
        .eq('prompt_type', 1)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (promptError) {
        console.error('Error fetching prompt_text:', promptError);
        return null;
    }

    if (!promptData) {
        console.log('No matching prompt found for tenant_id:', tenantId);
        return null;
    }

    console.log('Retrieved prompt:', promptData.prompt_text);
    return promptData.prompt_text;
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all('/incoming-call', async (request, reply) => {
    const toPhoneNumber = request.body.To || request.query.To;
    const systemMessage = await getPromptByPhoneNumber(toPhoneNumber) || 'You are a helpful and bubbly AI assistant...';
    console.log('Using system message:', systemMessage);

    // Generate a unique key for this system message
    const messageKey = uuidv4();

    // Store the system message in Redis with a 1-hour expiration
    await redisClient.set(messageKey, systemMessage, {
        EX: 3600 // 1 hour in seconds
    });

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              
                              <Say>Hello, how can I help you?</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream?key=${messageKey}" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
        console.log('Client connected');

        const url = new URL(req.url, `http://${req.headers.host}`);
        const messageKey = url.searchParams.get('key');
        let systemMessage = 'You are a helpful and bubbly AI assistant...';

        if (messageKey) {
            const storedMessage = await redisClient.get(messageKey);
            if (storedMessage) {
                systemMessage = storedMessage;
            } else {
                console.log('No message found for key:', messageKey);
            }
        }

        console.log('System message in WebSocket:', systemMessage);

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        // Initialize transcript array to store conversation
        const transcript = [];

        const sendSessionUpdate = () => {
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
                    speech_recognition: {
                        enabled: true,
                        language: 'en'
                    }
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                // Handle assistant's audio responses
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.socket.send(JSON.stringify(audioDelta));
                }

                // Handle assistant's text responses and add to transcript
                if (response.type === 'response.content' && response.content) {
                    const assistantResponse = response.content;
                    console.log('Assistant response:', assistantResponse);

                    // Add assistant's response to transcript
                    transcript.push({ speaker: 'Assistant', text: assistantResponse });
                }

                // Handle user's speech recognition results
                if (response.type === 'speech.recognition.result') {
                    const userSpeech = response.text;
                    console.log('User said:', userSpeech);

                    // Add user's speech to transcript
                    transcript.push({ speaker: 'User', text: userSpeech });
                }

                // Handle end of assistant's response
                if (response.type === 'response.done') {
                    console.log('Assistant has finished speaking.');
                }

            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.socket.on('message', (message) => {
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
        connection.socket.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');

            // Output the transcript
            console.log('Call Transcript:');
            transcript.forEach((entry) => {
                console.log(`${entry.speaker}: ${entry.text}`);
            });

            // Optionally, save the transcript to a database or file here
            // For example:
            // saveTranscriptToDatabase(transcript);
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Start the Fastify server and connect to Redis
const start = async () => {
    try {
        await redisClient.connect();
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`Server is listening on port ${PORT}`);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully');
    await redisClient.quit();
    await fastify.close();
    process.exit(0);
});