import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { createClient } from '@supabase/supabase-js';

// Load environment variables from .env file
dotenv.config();

// Add this near the top of your file, with other imports
const CALL_DURATION_LIMIT = 5 * 60 * 1000; // 5 minutes in milliseconds

// Retrieve the OpenAI API key and Supabase credentials from environment variables
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing required environment variables. Please check your .env file.");
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Define the Breeze Electric Voice Assistant Prompt
const SYSTEM_MESSAGE = `
# Simplified AI Prompt for Breeze Electric Voice Assistant
You are a voice assistant for Breeze Electric in Dallas, TX. Handle after-hours scheduling, answer questions, and book appointments efficiently and professionally.
## Core Conversation Flow
1. Greeting: "Thank you for calling Breeze Electric. How can I assist you today?"
2. Collect Information (one at a time):
   - Name: "May I have your name, please?"
   - Phone: "What's the best phone number to reach you?"
   - Address: "What's the address for the service?"
   - Issue: "Can you briefly describe the electrical issue?"
3. Assess Urgency: "Is this an urgent issue that needs immediate attention?"
4. Scheduling: "When would you prefer us to schedule the visit?"
5. Confirm Details: Repeat collected information for confirmation.
6. Create Ticket: "I've created a ticket for your [issue]. A representative will call to confirm the appointment time."
7. Close Call: "Thank you for choosing Breeze Electric. Have a great day! Goodbye."
## Key Guidelines
- Ask one question at a time and wait for a response.
- Maintain a professional and friendly tone.
- Don't mention pricing unless asked. If asked, state: "Our service fee is $79.99 for the initial visit. Total cost depends on the job specifics."
- Don't attempt to check or confirm appointment availability.
- Request clarification for incomplete information.
- Stay on topic, redirecting unrelated questions to scheduling or service inquiries.
- Show emotional intelligence based on the caller's mood.
- Avoid meta-commentary or mentioning internal processes.
- Ensure clarity and accuracy in responses.
- Always end with a polite farewell.
## Additional Notes
- Handle appointment cancellations by offering to reschedule or noting the cancellation.
- Inform about text updates for appointments.
- For this demo, allow scheduling from any location.
`;

// Constants
const VOICE = "shimmer";
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "conversation.item.input_audio_transcription.completed",
  "response.text.delta",
  "response.text.done",
  "response.audio_transcript.delta",
  "response.audio_transcript.done",
];

let goodbyeDetected = false;

// Track drift between OpenAI and system clocks, and the assistant's last Item ID
let localStartTime;
let lastDrift = null;
let lastAssistantItem;

let silentRequests = new Map();
let requestCounter = 0;

// Initialize transcription storage
let userTranscription = "";
let assistantTranscription = "";
let finalSummary = "";

// Function to check for goodbye phrases
const checkForGoodbye = (text) => {
  const goodbyes = [
    "goodbye",
    "bye",
    "see you",
    "farewell",
    "talk to you later",
    "take care",
    "so long",
  ];
  const textLower = text.toLowerCase();
  return goodbyes.some((phrase) => textLower.includes(phrase));
};

// Function to process the end of call
async function processEndOfCall(transcription) {
  try {
    const summaryPrompt = `
      Provide a brief summary of the following conversation:
      ${transcription}
    `;
    const summary = await makeSilentRequest(summaryPrompt);

    const actionItemsPrompt = `
      List key action items from the following conversation:
      ${transcription}
    `;
    const actionItems = await makeSilentRequest(actionItemsPrompt);

    console.log("Call Summary:", summary);
    console.log("Action Items:", actionItems);

    // After all processing is done, you can close the connection
    openAiWs.close();
  } catch (error) {
    console.error("Error in end-of-call processing:", error);
    openAiWs.close();
  }
}

// Function to lookup tenant_id and prompt
async function lookupPrompt(phoneNumber) {
  try {
    // First, lookup the tenant_id from the Organizations table
    const { data: orgData, error: orgError } = await supabase
      .from('Organizations')
      .select('tenant_id')
      .eq('phone_number', phoneNumber)
      .limit(1)
      .single();  
    if (orgError) throw orgError;
    if (!orgData) throw new Error('Organization not found');

    const tenant_id = orgData.tenant_id;

    // Next, lookup the prompt from the prompts table
    const { data: promptData, error: promptError } = await supabase
      .from('prompts')
      .select('content')
      .eq('tenant_id', tenant_id)
      .limit(1)
      .single();

    if (promptError) throw promptError;
    if (!promptData) throw new Error('Prompt not found');

    return promptData.content;
  } catch (error) {
    console.error('Error looking up prompt:', error);
    return null;
  }
}

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all("/incoming-call", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>                            
        <Connect>
            <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
    </Response>`;
  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media streaming
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, async (connection, req) => {
    console.log("Client connected");
    console.log(`Incoming call from ${req.raw.url}`);

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    let streamSid = null;
    let callSid = null;
    let dynamicPrompt = null;

    const initializeSession = async () => {
      if (callSid) {
        dynamicPrompt = await lookupPrompt(callSid);
      }

      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: dynamicPrompt || SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
          input_audio_transcription: {
            model: "whisper-1",
          },
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      sendInitialConversationItem();
    };

    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: 'Greet the user with "Hello there! How can I help you?"',
            },
          ],
        },
      };

      console.log(
        "Sending initial conversation item:",
        JSON.stringify(initialConversationItem)
      );
      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      localStartTime = Date.now(); // Start local timer
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    const handleSpeechStartedEvent = (response) => {
      const localTime = Date.now();
      const drift = localTime - localStartTime - response.audio_start_ms;

      console.log(
        "OpenAI Speech started at",
        response.audio_start_ms,
        "ms from OpenAI perspective"
      );
      console.log(
        "Local time at speech start:",
        localTime - localStartTime,
        "ms"
      );
      console.log("Time drift (OpenAI - Local):", drift, "ms");

      if (lastDrift === null || drift !== lastDrift) {
        console.log(
          "Drift has changed. Previous:",
          lastDrift,
          "Current:",
          drift
        );
        lastDrift = drift;
      }

      if (streamSid) {
        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid: streamSid,
          })
        );
      }

      if (lastAssistantItem) {
        const truncateEvent = {
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: response.audio_start_ms,
        };
        console.log("Sending truncation event:", JSON.stringify(truncateEvent));
        openAiWs.send(JSON.stringify(truncateEvent));
        lastAssistantItem = null;
      }
    };

    const handleResponseDoneEvent = (response) => {
      const outputItems = response.response.output;
      for (const item of outputItems) {
        if (item.role === "assistant") {
          lastAssistantItem = item.id;
          break; // Consider the first relevant assistant item
        }
      }
    };

    // Function to make a silent request
    function makeSilentRequest(prompt) {
      const requestId = requestCounter++;
      silentRequests.set(requestId, { response: "", resolve: null, reject: null });

      const silentConversationItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt,
            },
          ],
        },
      };

      openAiWs.send(JSON.stringify(silentConversationItem));

      const silentResponseRequest = {
        type: "response.create",
        response: {
          modalities: ["text"],
        },
        request_id: requestId.toString(),
      };
      openAiWs.send(JSON.stringify(silentResponseRequest));

      return new Promise((resolve, reject) => {
        silentRequests.get(requestId).resolve = resolve;
        silentRequests.get(requestId).reject = reject;
      });
    }

    // Listen for messages from the OpenAI WebSocket
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        console.log("Received event:", response.type);

        if (response.type === "error") {
          console.error("Error:", response.error);
          return;
        }

        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }

        // Capture user transcription
        if (response.type === "conversation.item.input_audio_transcription.completed") {
          console.log("User transcription:", response.transcript);
          userTranscription += response.transcript;

          if (checkForGoodbye(response.transcript)) {
            console.log("User said goodbye. Ending call.");
            if (connection) {
              connection.close();
            }
          }
        }

        if (response.type === "response.text.delta" && response.request_id) {
          const requestId = parseInt(response.request_id);
          if (silentRequests.has(requestId)) {
            silentRequests.get(requestId).response += response.delta;
          }
        }

        if (response.type === "response.text.done" && response.request_id) {
          const requestId = parseInt(response.request_id);
          if (silentRequests.has(requestId)) {
            const request = silentRequests.get(requestId);
            request.resolve(request.response);
            silentRequests.delete(requestId);
          }
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }

        // When assistant's response is done
        if (response.type === "response.audio_transcript.done") {
          console.log("Assistant transcription done:", response.transcript);
          assistantTranscription += response.transcript + "\n";

          if (checkForGoodbye(response.transcript)) {
            console.log("Goodbye detected in assistant's response. Preparing to end call.");
            goodbyeDetected = true;
          }

          if (goodbyeDetected) {
            console.log("Goodbye confirmed. Ending call after this audio segment.");
            if (connection) {
              connection.close();
            }
            goodbyeDetected = false; // Reset the flag
          }
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent(response);
        }

        if (response.type === "response.done") {
          handleResponseDoneEvent(response);
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

        // Handle incoming messages from Twilio
    connection.on("message", async (message) => {
        try {
          const data = JSON.parse(message);
  
          switch (data.event) {
            case "media":
              if (openAiWs.readyState === WebSocket.OPEN) {
                const audioAppend = {
                  type: "input_audio_buffer.append",
                  audio: data.media.payload,
                };
                openAiWs.send(JSON.stringify(audioAppend));
              }
              break;
  
            case "connected":
              // Handle connected event if needed
              break;
  
            case "mark":
              // This event is sent by Twilio when speech ends
              if (goodbyeDetected) {
                console.log("Call ended. Processing final summary.");
                await processEndOfCall(userTranscription + "\n" + assistantTranscription);
                // Don't close the connection immediately
                // connection.close() will be called after processing the silent request
              }
              break;
  
            case "start":
              streamSid = data.start.streamSid;
              callSid = data.start.callSid;
              console.log("Incoming stream has started", streamSid);
              console.log("CallSid:", callSid);

               // Set the call start time and initialize the duration timer
                callStartTime = Date.now();
                callDurationTimer = setTimeout(() => {
                    console.log("Call duration limit reached. Ending call.");
                    endCall(connection, openAiWs);
                }, CALL_DURATION_LIMIT);


              await initializeSession(); // Call initializeSession after capturing callSid
              break;
  
            default:
              console.log("Received non-media event:", data.event);
              break;
          }
        } catch (error) {
          console.error("Error parsing message:", error, "Message:", message);
        }
      });
  
      // Handle connection close
      connection.on("close", () => {
        clearTimeout(callDurationTimer);
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();

        console.log("Client disconnected.");

        const callDuration = Date.now() - callStartTime;
        console.log(`Call duration: ${callDuration / 1000} seconds`);
        
  
        // Output the final transcriptions
        console.log("Final User Transcription:\n", userTranscription);
        console.log("Final Assistant Transcription:\n", assistantTranscription);
      });
  
      // Handle WebSocket close and errors
      openAiWs.on("close", () => {
        console.log("Disconnected from the OpenAI Realtime API");
      });
  
      openAiWs.on("error", (error) => {
        console.error("Error in the OpenAI WebSocket:", error);
      });
    });
  });

  // Add this function after the WebSocket route handler
function endCall(connection, openAiWs) {
    clearTimeout(callDurationTimer);
    
    if (connection && connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close();
    }
    
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
    
    processEndOfCall(userTranscription + "\n" + assistantTranscription);
  }
  
  
  // Start the server
  fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
  });