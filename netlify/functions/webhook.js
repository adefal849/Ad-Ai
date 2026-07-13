// netlify/functions/webhook.js
// Webhook Facebook Messenger + IA Groq + mémoire en RAM
// Corrigé le 13/07/2026 : endpoint Send API /{PAGE_ID}/messages (au lieu de /me/messages)
// + ajout du paramètre obligatoire messaging_type, conformes à la doc Meta en vigueur.

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAGE_ID = process.env.PAGE_ID; // ID numérique de ta Page, ex: 1119173861280869

const GRAPH_API_VERSION = "v25.0";
const MAX_HISTORY = 10;

const SYSTEM_PROMPT = {
  role: "system",
  content:
    "Tu es Adéfal AI, un assistant conversationnel sympathique et naturel, qui discute librement avec les utilisateurs sur Messenger. Réponds en français par défaut, de façon chaleureuse et concise.",
};

// Mémoire en RAM : persiste tant que l'instance de la fonction reste chaude.
const conversations = {};

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
    console.log("POST reçu, body:", JSON.stringify(body));

    if (body.object === "page") {
      for (const entry of body.entry) {
        const webhookEvent = entry.messaging?.[0];
        if (!webhookEvent) {
          console.log("Aucun webhookEvent dans cette entry:", JSON.stringify(entry));
          continue;
        }

        const senderId = webhookEvent.sender.id;
        console.log("senderId:", senderId, "event:", JSON.stringify(webhookEvent));

        if (webhookEvent.message && webhookEvent.message.text) {
          const userText = webhookEvent.message.text;
          console.log("Texte reçu:", userText);
          await handleMessage(senderId, userText);
        } else {
          console.log("Pas de texte de message dans cet event (probablement delivery/read/echo).");
        }
      }
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
    console.log("body.object n'est pas 'page':", body.object);
    return { statusCode: 404, body: "Not Found" };
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

// ==== 3. Traitement du message ====
async function handleMessage(senderId, userText) {
  try {
    await sendTypingIndicator(senderId, "typing_on");

    if (!conversations[senderId]) {
      conversations[senderId] = [SYSTEM_PROMPT];
    }
    let history = conversations[senderId];

    history.push({ role: "user", content: userText });

    if (history.length > MAX_HISTORY + 1) {
      history = [history[0], ...history.slice(-MAX_HISTORY)];
    }

    const aiReply = await callGroq(history);
    console.log("Réponse Groq reçue:", aiReply);

    history.push({ role: "assistant", content: aiReply });
    conversations[senderId] = history;

    await sendTypingIndicator(senderId, "typing_off");
    const sendResult = await sendMessage(senderId, aiReply);
    console.log("Résultat sendMessage:", JSON.stringify(sendResult));
  } catch (err) {
    console.error("Erreur handleMessage:", err.message);
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
// Endpoint conforme à la doc Meta actuelle : POST /{PAGE-ID}/messages
async function sendMessage(recipientId, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_type: "RESPONSE", // paramètre obligatoire, absent avant correction
      recipient: { id: recipientId },
      message: { text: text },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Erreur sendMessage:", JSON.stringify(data));
  }
  return data;
}

// ==== 6. Indicateur "en train d'écrire" ====
async function sendTypingIndicator(recipientId, action) {
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: action,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Erreur typing indicator:", JSON.stringify(data));
    }
  } catch (err) {
    console.error("Erreur typing indicator (catch):", err.message);
  }
}
