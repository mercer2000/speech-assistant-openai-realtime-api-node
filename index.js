import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';
import { createClient as createRedisClient } from 'redis';

// Load environment variables from .env file
dotenv.config();

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
fastify.post('/incoming-call', async (request, reply) => {
    console.log('Received incoming call webhook');
    console.log('Request body:', request.body);

    const toNumber = request.body.To;
    const fromNumber = request.body.From;
    const callSid = request.body.CallSid;

    if (!toNumber) {
        console.error('No "To" number provided in the request body');
        reply.code(400).send('Bad Request: Missing To number');
        return;
    }

    console.log(`Incoming call to number: ${toNumber} from ${fromNumber}, CallSid: ${callSid}`);

    try {
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

        // Store the system prompt in Redis with the CallSid as the key
        await redisClient.set(`prompt:${callSid}`, systemPrompt, { EX: 3600 }); // Expires in 1 hour

        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Say>Hello, how can I help you?</Say>
                                  <Connect>
                                      <Stream url="wss://${request.hostname}/media-stream?callSid=${encodeURIComponent(callSid)}" />
                                  </Connect>
                              </Response>`;

        console.log('Sending TwiML response:', twimlResponse);
        reply.type('text/xml').send(twimlResponse);
    } catch (error) {
        console.error('Error processing incoming call:', error);
        reply.code(500).send('Internal Server Error');
    }
});

ffastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('WebSocket client connected');
        console.log('Full request object:', req);

        // Try to get callSid from different possible locations
        let callSid = req.query.callSid || 
                      (req.url && new URL(req.url, `http://${req.headers.host}`).searchParams.get('callSid'));

        if (!callSid && req.headers['sec-websocket-protocol']) {
            // If callSid is in Sec-WebSocket-Protocol header
            const protocols = req.headers['sec-websocket-protocol'].split(',');
            const callSidProtocol = protocols.find(p => p.trim().startsWith('callSid='));
            if (callSidProtocol) {
                callSid = callSidProtocol.split('=')[1];
            }
        }

        if (!callSid) {
            console.error('No "callSid" provided in query parameters or headers');
            connection.socket.send(JSON.stringify({ error: 'No callSid provided' }));
            connection.socket.close();
            return;
        }

        console.log(`WebSocket connection initiated for CallSid: ${callSid}`);

        // Retrieve the system prompt from Redis
        redisClient.get(`prompt:${callSid}`).then(SYSTEM_MESSAGE => {
            if (!SYSTEM_MESSAGE) {
                console.error(`No system prompt found for CallSid: ${callSid}`);
                connection.socket.send(JSON.stringify({ error: 'No system prompt found' }));
                connection.socket.close();
                return;
            }

            console.log(`Retrieved SYSTEM_MESSAGE for CallSid ${callSid}: ${SYSTEM_MESSAGE}`);

            // OpenAI WebSocket connection setup
            const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1"
                }
            });
    fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
        console.log('WebSocket client connected');
        console.log('WebSocket request URL:', req.url);

        // Parse the URL manually to extract the callSid
        const urlParts = req.url.split('?');
        let callSid = null;
        if (urlParts.length > 1) {
            const queryParams = new URLSearchParams(urlParts[1]);
            callSid = queryParams.get('callSid');
        }

        if (!callSid) {
            console.error('No "callSid" provided in query parameters');
            connection.socket.send(JSON.stringify({ error: 'No callSid provided' }));
            connection.socket.close();
            return;
        }

        console.log(`WebSocket connection initiated for CallSid: ${callSid}`);

        // Retrieve the system prompt from Redis
        const SYSTEM_MESSAGE = await redisClient.get(`prompt:${callSid}`);
        if (!SYSTEM_MESSAGE) {
            console.error(`No system prompt found for CallSid: ${callSid}`);
            connection.socket.send(JSON.stringify({ error: 'No system prompt found' }));
            connection.socket.close();
            return;
        }

        console.log(`Retrieved SYSTEM_MESSAGE for CallSid ${callSid}: ${SYSTEM_MESSAGE}`);

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
                    connection.socket.send(JSON.stringify(audioDelta));
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
        connection.socket.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            await redisClient.del(`prompt:${callSid}`);
            console.log(`WebSocket closed for CallSid: ${callSid}`);
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

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    await redisClient.quit();
    process.exit(0);
});