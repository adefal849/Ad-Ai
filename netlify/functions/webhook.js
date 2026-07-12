// netlify/functions/webhook.js
// Webhook Facebook Messenger + IA Groq + mémoire persistante via Netlify Blobs

const { getStore } = require("@netlify/blobs");

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const MAX_HISTORY = 10; // nombre de messages gardés par utilisateur

const SYSTEM_PROMPT = {
  role: "system",
  content:
    "Tu es Adéfal AI, un assistant conversationnel sympathique et naturel, qui discute librement avec les utilisateurs sur Messenger. Réponds en français par défaut, de façon chaleureuse et concise.",
};

exports.handler = async (event) => {
  // ==== 1. Vérification du webhook (GET) ====
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const mode = params["hub.mode"];
    const token = params["hub.verify_token"];
    const challenge = params["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: "Verification failed" };
  }

  // ==== 2. Réception des messages (POST) ====
  if (event.httpMethod === "POST") {
    const body = JSON.parse(event.body);

    if (body.object === "page") {
      for (const entry of body.entry) {
        const webhookEvent = entry.messaging?.[0];
        if (!webhookEvent) continue;

        const senderId = webhookEvent.sender.id;

        if (webhookEvent.message && webhookEvent.message.text) {
          const userText = webhookEvent.message.text;
          // On ne bloque pas la réponse à Meta sur le traitement complet,
          // mais sur Netlify Functions (contrairement à un serveur long-running),
          // il faut attendre la fin du traitement avant de renvoyer la réponse HTTP,
          // sinon la fonction est coupée avant d'avoir fini.
          await handleMessage(senderId, userText);
        }
      }
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
    return { statusCode: 404, body: "Not Found" };
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

// ==== 3. Traitement du message ====
async function handleMessage(senderId, userText) {
  try {
    await sendTypingIndicator(senderId, "typing_on");

    const store = getStore("conversations");
    const key = `user-${senderId}`;

    let history = (await store.get(key, { type: "json" })) || [SYSTEM_PROMPT];

    history.push({ role: "user", content: userText });

    // Limiter la taille (garder le system prompt + N derniers messages)
    if (history.length > MAX_HISTORY + 1) {
      history = [history[0], ...history.slice(-MAX_HISTORY)];
    }

    const aiReply = await callGroq(history);

    history.push({ role: "assistant", content: aiReply });
    await store.setJSON(key, history);

    await sendTypingIndicator(senderId, "typing_off");
    await sendMessage(senderId, aiReply);
  } catch (err) {
    console.error("Erreur handleMessage:", err.response?.data || err.message);
    await sendMessage(
      senderId,
      "Désolé, j'ai eu un souci technique. Réessaie dans un instant 🙏"
    );
  }
}

// ==== 4. Appel à l'API Groq ====
async function callGroq(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: messages,
      temperature: 0.8,
      max_tokens: 500,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Groq error: ${JSON.stringify(data)}`);
  }
  return data.choices[0].message.content;
}

// ==== 5. Envoi d'un message via l'API Facebook Send ====
async function sendMessage(recipientId, text) {
  await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: text },
      }),
    }
  );
}

// ==== 6. Indicateur "en train d'écrire" ====
async function sendTypingIndicator(recipientId, action) {
  try {
    await fetch(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          sender_action: action,
        }),
      }
    );
  } catch (err) {
    console.error("Erreur typing indicator:", err.message);
  }
}
