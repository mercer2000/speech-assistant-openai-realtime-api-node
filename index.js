import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';
import { createClient as createRedisClient } from 'redis';

// Load environment variables from .env file
dotenv.config();

// Near the top of the file, after the other constant definitions:
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment


// Retrieve environment variables
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY, REDIS_URL } = process.env;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY || !REDIS_URL) {
    console.error('Missing required environment variables. Please check your .env file.');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Initialize Redis client
const redisClient = createRedisClient({ url: REDIS_URL });
redisClient.connect().catch(console.error);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ... (rest of the constants and configurations remain the same)

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    const toNumber = request.body.To;
    console.log(`Incoming call to number: ${toNumber}`);
    console.log(`Request host: ${request.headers.host}`);

    // Fetch tenant_id from phone_numbers table
    const { data: phoneData, error: phoneError } = await supabase
        .from('phone_numbers')
        .select('tenant_id')
        .eq('phone_number', toNumber)
        .limit(1)
        .single();

    if (phoneError || !phoneData) {
        console.error('Error fetching tenant_id from phone_numbers:', phoneError || 'No data returned');
        reply.code(500).send('Internal Server Error');
        return;
    }

    const tenantId = phoneData.tenant_id;

    // Fetch prompt_text from prompts table
    const { data: promptData, error: promptError } = await supabase
        .from('prompts')
        .select('prompt_text')
        .eq('tenant_id', tenantId)
        .limit(1)
        .single();

    if (promptError || !promptData) {
        console.error('Error fetching prompt from prompts table:', promptError || 'No data returned');
        reply.code(500).send('Internal Server Error');
        return;
    }

    const systemPrompt = promptData.prompt_text;

    // Store the system prompt in Redis with the phone number as the key
    await redisClient.set(`prompt:${toNumber}`, systemPrompt, { EX: 3600 }); // Expires in 1 hour

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
        if (!toNumber) {
            console.error('No "to" number provided in query parameters');
            connection.socket.close();
            return;
        }
        console.log(`WebSocket connection initiated for number: ${toNumber}`);

        // Retrieve the system prompt from Redis
        const SYSTEM_MESSAGE = await redisClient.get(`prompt:${toNumber}`);
        if (!SYSTEM_MESSAGE) {
            console.error(`No system prompt found for number: ${toNumber}`);
            connection.socket.close();
            return;
        }
        console.log(`Retrieved SYSTEM_MESSAGE for number ${toNumber}: ${SYSTEM_MESSAGE}`);

        // OpenAI WebSocket connection
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // ... (rest of the WebSocket handling code remains the same)

        // Remember to remove the prompt from Redis when the call ends
        connection.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            await redisClient.del(`prompt:${toNumber}`);
            console.log('Client disconnected.');
        });

        // ... (rest of the code remains the same)
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

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    await redisClient.quit();
    process.exit(0);
});