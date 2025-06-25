// === server.js ===
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIO = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

const sessionMap = new Map();
let connectedSenders = new Set();
const messageHistory = new Map();

// Facebook Webhook Verification
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = "hello";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Facebook Webhook Event Handling
app.post('/webhook', (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    body.entry.forEach(entry => {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;
      if (webhookEvent.message && webhookEvent.message.text) {
        const messageText = webhookEvent.message.text;
        console.log("Received:", messageText);

        connectedSenders.add(senderId);
        io.emit("message", { senderId, message: messageText });
        io.emit("senderList", Array.from(connectedSenders));

        if (!messageHistory.has(senderId)) messageHistory.set(senderId, []);
        messageHistory.get(senderId).push({ from: "user", text: messageText });

        const session = sessionMap.get(senderId);
        if (session?.assignToAI) {
          sendToGemini(session.aiKey, messageText, session.systemPrompt).then(aiReply => {
            if (aiReply) {
              sendMessage(senderId, aiReply, session.fbToken);
              messageHistory.get(senderId).push({ from: "ai", text: aiReply });
            }
          });
        }
      }
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Socket.IO Events
io.on("connection", (socket) => {
  console.log("Client connected");

  socket.emit("senderList", Array.from(connectedSenders));

  socket.on("send", async ({ senderId, message, fbToken }) => {
    await sendMessage(senderId, message, fbToken);
    if (!messageHistory.has(senderId)) messageHistory.set(senderId, []);
    messageHistory.get(senderId).push({ from: "admin", text: message });
  });

  socket.on("assignAI", ({ senderId, aiKey, fbToken, assignToAI, systemPrompt }) => {
    sessionMap.set(senderId, { aiKey, fbToken, assignToAI, systemPrompt });
    console.log(`AI ${assignToAI ? "assigned" : "removed"} for ${senderId}`);
  });

  socket.on("broadcast", ({ message, fbToken }) => {
    connectedSenders.forEach(senderId => {
      sendMessage(senderId, message, fbToken);
      if (!messageHistory.has(senderId)) messageHistory.set(senderId, []);
      messageHistory.get(senderId).push({ from: "admin", text: message });
    });
  });

  socket.on("getHistory", (senderId, callback) => {
    callback(messageHistory.get(senderId) || []);
  });
});

// Send message to Facebook user
async function sendMessage(senderId, message, fbToken) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${fbToken}`;
  const payload = {
    recipient: { id: senderId },
    message: { text: message },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    console.log("Sent:", data);
  } catch (err) {
    console.error("Error sending message:", err);
  }
}

// Send prompt to Gemini AI
async function sendToGemini(apiKey, userText, systemPrompt) {
  try {
    const parts = systemPrompt ? [{ text: systemPrompt }, { text: userText }] : [{ text: userText }];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] })
    });
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "(No response from AI)";
  } catch (e) {
    console.error("AI Error:", e);
    return null;
  }
}

server.listen(PORT, () => console.log("Server running on port", PORT));
