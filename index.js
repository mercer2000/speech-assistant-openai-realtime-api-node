import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { createClient } from '@supabase/supabase-js';

// Load environment variables from .env file
dotenv.config();

// Constants
const CALL_DURATION_LIMIT = 5 * 60 * 1000; // 5 minutes in milliseconds
const VOICE = "shimmer";
const PORT = process.env.PORT || 5050;

// Retrieve the OpenAI API key and Supabase credentials from environment variables
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY } = process.env;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing required environment variables. Please check your .env file.");
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// Global variables
let localStartTime;
let lastDrift = null;
let lastAssistantItem;
let silentRequests = new Map();
let requestCounter = 0;
let userTranscription = "";
let assistantTranscription = "";
let callDurationTimer;
let callStartTime;

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
    "have a great day",
  ];
  const textLower = text.toLowerCase();
  return goodbyes.some(phrase => textLower.includes(phrase));
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

  } catch (error) {
    console.error("Error in end-of-call processing:", error);
  }
}

// Function to lookup tenant_id and prompt
async function lookupPrompt(phoneNumber) {

    console.log("Looking up prompt for phone number:", phoneNumber);
  try {
    const { data: orgData, error: orgError } = await supabase
      .from('Organizations')
      .select('tenant_id')
      .eq('phone_number', phoneNumber)
      .limit(1)
      .single();  
    if (orgError) throw orgError;
    if (!orgData) throw new Error('Organization not found');

    const tenant_id = orgData.tenant_id;

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
    return SYSTEM_MESSAGE;
  }
}

// Function to send final message and wait for response
async function sendFinalMessageAndWaitForResponse(openAiWs) {
  return new Promise((resolve, reject) => {
    const finalMessage = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Please provide a brief summary of our conversation and any next steps.",
          },
        ],
      },
    };

    console.log("Sending final message to agent");
    openAiWs.send(JSON.stringify(finalMessage));
    openAiWs.send(JSON.stringify({ type: "response.create", response: { modalities: ["text"] } }));

    let finalResponse = "";

    const messageHandler = (data) => {
      const response = JSON.parse(data);

      if (response.type === "response.text.delta") {
        finalResponse += response.delta;
      } else if (response.type === "response.text.done") {
        console.log("Final response from agent:", finalResponse);
        openAiWs.removeListener("message", messageHandler);
        resolve(finalResponse);
      }
    };

    openAiWs.on("message", messageHandler);

    // Set a timeout in case the agent doesn't respond
    setTimeout(() => {
      openAiWs.removeListener("message", messageHandler);
      reject(new Error("Timeout waiting for agent's final response"));
    }, 30000); // 30 seconds timeout
  });
}

// Function to end the call
async function endCall(connection, openAiWs) {
  if (callDurationTimer) {
    clearTimeout(callDurationTimer);
    callDurationTimer = null;
  }

  try {
    console.log("Sending final message to agent and waiting for response");
    const finalResponse = await sendFinalMessageAndWaitForResponse(openAiWs);
    console.log("Received final response from agent");

    // Add the final response to the assistant transcription
    assistantTranscription += "\nFinal Summary: " + finalResponse + "\n";

    // Process the end of call with the updated transcription
    await processEndOfCall(userTranscription + "\n" + assistantTranscription);
  } catch (error) {
    console.error("Error during final message exchange:", error);
  } finally {
    // Close connections
    if (connection && connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close();
    }
    
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
    
    const callDuration = Date.now() - callStartTime;
    console.log(`Call ended. Duration: ${callDuration / 1000} seconds`);
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
        console.log ("Dynamic prompt:", dynamicPrompt); 
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
          
          // Check for goodbye in the assistant's response
          if (checkForGoodbye(item.content[0].text)) {
            console.log("Goodbye detected in assistant's response. Initiating end call procedure.");
            endCall(connection, openAiWs);
          }
          
          break;
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

        if (response.type === "conversation.item.input_audio_transcription.completed") {
          console.log("User transcription:", response.transcript);
          userTranscription += response.transcript;

          if (checkForGoodbye(response.transcript)) {
            console.log("User said goodbye. Ending call.");
            endCall(connection, openAiWs);
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
      
              if (response.type === "response.audio_transcript.done") {
                console.log("Assistant transcription done:", response.transcript);
                assistantTranscription += response.transcript + "\n";
      
                if (checkForGoodbye(response.transcript)) {
                  console.log("Goodbye detected in assistant's response. Ending call.");
                  endCall(connection, openAiWs);
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
          connection.socket.on("message", async (message) => {
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
      
                case "start":
                  streamSid = data.start.streamSid;
                  callSid = data.start.callSid;
                  console.log("Incoming stream has started", streamSid);
                  console.log("CallSid:", callSid);
      
                  callStartTime = Date.now();
                  callDurationTimer = setTimeout(() => {
                    console.log("Call duration limit reached. Ending call.");
                    endCall(connection, openAiWs);
                  }, CALL_DURATION_LIMIT);
      
                  await initializeSession();
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
          connection.socket.on("close", () => {
            console.log("Client disconnected.");
            if (callDurationTimer) {
              clearTimeout(callDurationTimer);
            }
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.close();
            }
            const callDuration = Date.now() - callStartTime;
            console.log(`Call duration: ${callDuration / 1000} seconds`);
          });
      
          // Handle WebSocket errors
          openAiWs.on("error", (error) => {
            console.error("Error in the OpenAI WebSocket:", error);
          });
      
          // Open event for OpenAI WebSocket
          openAiWs.on("open", () => {
            localStartTime = Date.now();
            console.log("Connected to the OpenAI Realtime API");
            setTimeout(initializeSession, 100);
          });
        });
      });
      
      // Start the server
      fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
        if (err) {
          console.error(err);
          process.exit(1);
        }
        console.log(`Server is listening on port ${PORT}`);
      });