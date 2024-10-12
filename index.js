import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key and Supabase credentials from environment variables
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

if (
  !OPENAI_API_KEY ||
  !SUPABASE_URL ||
  !SUPABASE_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN
) {
  console.error(
    "Missing required environment variables. Please check your .env file."
  );
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Initialize Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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
const VOICE = "shimmer"; // Options: alloy, echo, or shimmer
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
  // Added events for transcription
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
let summarySent = false;

// Initialize transcription storage
let userTranscription = "";
let assistantTranscription = "";

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
    "have a good day",
  ];
  const textLower = text.toLowerCase();
  return goodbyes.some((phrase) => textLower.includes(phrase));
};

const sendSummaryRequest = () => {
  if (summarySent) return;
  summarySent = true;

  const summaryRequest = {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Please provide a JSON summary of our conversation, including the caller's name, phone number, address, issue description, urgency, and scheduled appointment time if applicable. Do not generate an audio response for this.",
        },
      ],
    },
  };

  console.log("Sending summary request:", JSON.stringify(summaryRequest));
  openAiWs.send(JSON.stringify(summaryRequest));
  openAiWs.send(JSON.stringify({ type: "response.create" }));
};

// Function to get the called number using Twilio API
async function getCalledNumber(callSid) {
  try {
    const call = await client.calls(callSid).fetch();
    console.log(`The called number is: ${call.to}`);
    return call.to;
  } catch (error) {
    console.error("Error fetching call details:", error);
    return null;
  }
}

// Function to lookup tenant_id and prompt
async function lookupPrompt(callSid) {
  let phoneNumber = await getCalledNumber(callSid);
  if (!phoneNumber) {
    console.error("Could not retrieve phone number.");
    return null;
  }

  console.log("Looking up prompt for phone number:", phoneNumber);

  try {
    // First, lookup the tenant_id from the phone number talbe table
    const { data: orgData, error: orgError } = await supabase
      .from("phone_numbers")
      .select("tenant_id")
      .eq("phone_number", phoneNumber)
      .single();

    if (orgError) throw orgError;
    if (!orgData) throw new Error("Organization not found");

    const tenant_id = orgData.tenant_id;

    // Next, lookup the prompt from the prompts table
    const { data: promptData, error: promptError } = await supabase
      .from("prompts")
      .select("content")
      .eq("tenant_id", tenant_id)
      .single();

    if (promptError) throw promptError;
    if (!promptData) throw new Error("Prompt not found");

    console.log("Prompt found:", promptData.content);

    return promptData.content;
  } catch (error) {
    console.error("Error looking up prompt:", error);
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

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");
    console.log(`Incoming request URL: ${req.url}`);

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

    let openAiWsIsOpen = false;
    let sessionInitialized = false;
    let assistantSaidGoodbye = false;
    let userSaidGoodbye = false;
    let lastAudioDeltaTime = Date.now();

    const initializeSession = async () => {
      if (sessionInitialized) return;
      if (!callSid || !openAiWsIsOpen) {
        console.log(
          "Cannot initialize session yet. Waiting for callSid and openAiWsIsOpen."
        );
        return;
      }
      sessionInitialized = true;

      dynamicPrompt = await lookupPrompt(callSid);

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

      openAiWs.send(JSON.stringify(sessionUpdate));

      // Wait for a short time to ensure the initial session update is processed
      await new Promise((resolve) => setTimeout(resolve, 100));

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
              text: 'Greet the user with "Thank you for calling. How can I help you?"',
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
      openAiWsIsOpen = true;
      localStartTime = Date.now(); // Start local timer
      console.log("Connected to the OpenAI Realtime API");
      initializeSession();
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
        connection.socket.send(
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

    // Modify the handleResponseDoneEvent function
    const handleResponseDoneEvent = (response) => {

        console.log("Response done event received:", response);
        
      const outputItems = response.response.output;
      for (const item of outputItems) {
        if (item.role === "assistant") {
          lastAssistantItem = item.id;

          // Check if this is the summary response
          if (summarySent && item.content && item.content[0].type === "text") {
            console.log("Call Summary:", item.content[0].text);
            // Here you can process the summary, e.g., save it to a database
            break;
          }
        }
      }
      // If the assistant has said goodbye and we haven't sent the summary request yet, do it now
      if (assistantSaidGoodbye && !summarySent) {
        sendSummaryRequest();
      }
    };

    let audioDeltaTimeout = null;

    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (response.type === "error") {
          console.error("Error:", response.error);
          return;
        }

        if (
          response.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          console.log("User transcription:", response.transcript);
          userTranscription += response.transcript;

          if (checkForGoodbye(response.transcript)) {
            console.log(
              "User said goodbye. Will close the call after assistant responds."
            );
            userSaidGoodbye = true;
          }
        }

        // Send audio to Twilio and manage the timeout
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          if (
            connection.socket &&
            connection.socket.readyState === WebSocket.OPEN
          ) {
            connection.socket.send(JSON.stringify(audioDelta));
          }

          // Update the lastAudioDeltaTime when receiving a delta
          lastAudioDeltaTime = Date.now();

          // Reset the timeout since we received new audio data
          if (audioDeltaTimeout) {
            clearTimeout(audioDeltaTimeout);
          }

          // If assistant said goodbye, start the timeout to close the connection
          if (assistantSaidGoodbye) {
            audioDeltaTimeout = setTimeout(() => {
              console.log("Assistant's audio has finished. Closing the call.");
              if (
                connection &&
                connection.socket &&
                connection.socket.readyState === WebSocket.OPEN
              ) {
                connection.socket.close();
              }
            }, 1000); // Wait for 1 second of inactivity
          }
        }

        // When assistant's response is done
        if (response.type === "response.audio_transcript.done") {
          console.log("Assistant transcription done:", response.transcript);
          assistantTranscription += response.transcript + "\n";

          if (checkForGoodbye(response.transcript)) {
            console.log(
              "Assistant said goodbye. Will request summary before closing the call."
            );
            assistantSaidGoodbye = true;
            sendSummaryRequest();
          }
        }

        // Handle speech started event
        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent(response);
        }

        // No need to close the connection in response.done
        if (response.type === "response.done") {
          handleResponseDoneEvent(response);
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error.message,
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
            initializeSession();
            break;
          case "connected":
          case "mark":
            // Handle other events if necessary
            break;
          default:
            console.log("Received unknown event:", data.event);
            break;
        }
      } catch (error) {
        console.error(
          "Error parsing message:",
          error.message,
          "Message:",
          message
        );
      }
    });

    // Handle connection close
    connection.socket.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");

      // Output the final transcriptions
      console.log("Final User Transcription:\n", userTranscription);
      console.log("Final Assistant Transcription:\n", assistantTranscription);
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error(
        "Error in the OpenAI WebSocket:",
        error.message,
        error.stack
      );
    });

    connection.socket.on("error", (error) => {
      console.error("WebSocket connection error:", error.message, error.stack);
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
