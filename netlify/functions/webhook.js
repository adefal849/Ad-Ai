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

const SYSTEM_PROMPTS = {
  normal: {
    role: "system",
    content:
      "Tu es Adéfal AI, un assistant conversationnel sympathique et naturel, qui discute librement avec les utilisateurs sur Messenger. Réponds en français par défaut, de façon chaleureuse et concise.",
  },
  coder: {
    role: "system",
    content:
      "Tu es Adéfal AI en Mode Codeur : tu réponds comme un développeur senior, précis et direct. Tu donnes du code clair, commenté, et tu expliques brièvement tes choix techniques. Reste concis, va à l'essentiel, garde un ton professionnel mais chaleureux.",
  },
};
const SYSTEM_PROMPT = SYSTEM_PROMPTS.normal; // conservé pour compatibilité (vision, etc.)

// Mémoire en RAM : persiste tant que l'instance de la fonction reste chaude.
const conversations = {};
const userModes = {}; // senderId -> "normal" | "coder"

const MENU_TEXT =
  "━━━━━━━━━━━━━━━━━━━━\n" +
  "✨  F E M I   A I  ✨\n" +
  "━━━━━━━━━━━━━━━━━━━━\n\n" +
  "📜 Menu principal\n\n" +
  "🆘  help — afficher cette aide\n" +
  "🆔  id — ton identifiant Messenger\n" +
  "🔎  recherche <question> — recherche en temps réel sur le web\n" +
  "🎨  dessine-moi <description> — générer une image\n" +
  "🧑‍💻  mode codeur — bascule en assistant technique\n" +
  "💬  mode normal — retour au mode discussion classique\n\n" +
  "━━━━━━━━━━━━━━━━━━━━\n" +
  "Écris-moi normalement pour discuter, je suis là 🙂";

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

          const command = parseCommand(userText);
          if (command) {
            console.log("Commande détectée:", JSON.stringify(command));
            await handleCommand(senderId, command);
          } else {
            const imagePrompt = detectImageGenerationIntent(userText);
            if (imagePrompt) {
              console.log("Intention de génération d'image détectée, prompt:", imagePrompt);
              await handleImageGeneration(senderId, imagePrompt);
            } else {
              await handleMessage(senderId, userText);
            }
          }
        } else if (
          webhookEvent.message &&
          webhookEvent.message.attachments &&
          webhookEvent.message.attachments.some((a) => a.type === "image")
        ) {
          const imageAttachment = webhookEvent.message.attachments.find(
            (a) => a.type === "image"
          );
          const imageUrl = imageAttachment.payload.url;
          console.log("Image reçue:", imageUrl);
          await handleImageMessage(senderId, imageUrl);
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

    const mode = userModes[senderId] || "normal";
    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.normal;

    if (!conversations[senderId]) {
      conversations[senderId] = [systemPrompt];
    } else {
      // On garde le système à jour si l'utilisateur a changé de mode entre-temps
      conversations[senderId][0] = systemPrompt;
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

// ==== 3quinquies. Détection et gestion des commandes (menu, help, id, mode, recherche) ====
function parseCommand(text) {
  const t = text.trim().toLowerCase();

  if (t === "menu" || t === "/menu") return { type: "menu" };
  if (t === "help" || t === "/help" || t === "aide") return { type: "help" };
  if (t === "id" || t === "/id" || t === "mon id") return { type: "id" };
  if (t === "mode codeur" || t === "/coder" || t === "mode coder") return { type: "mode_coder" };
  if (t === "mode normal" || t === "/normal") return { type: "mode_normal" };

  const searchMatch = text.trim().match(/^(?:\/recherche|recherche|\/search|search)\s+(.+)$/i);
  if (searchMatch) return { type: "search", query: searchMatch[1].trim() };

  return null;
}

async function handleCommand(senderId, command) {
  try {
    switch (command.type) {
      case "menu":
      case "help":
        await sendMessage(senderId, MENU_TEXT);
        break;

      case "id":
        await sendMessage(
          senderId,
          `🆔 Ton identifiant Messenger (PSID) :\n${senderId}\n\n` +
            "ℹ️ Note d'honnêteté : Meta ne permet pas de relier cet identifiant à ton vrai nom ou profil public — c'est une restriction de confidentialité imposée par la plateforme, pas une limite de l'IA."
        );
        break;

      case "mode_coder":
        userModes[senderId] = "coder";
        if (conversations[senderId]) conversations[senderId][0] = SYSTEM_PROMPTS.coder;
        await sendMessage(
          senderId,
          "🧑‍💻 Mode Codeur activé. Je passe en assistant technique — code, debug, architecture. Écris 'mode normal' pour revenir à la discussion classique."
        );
        break;

      case "mode_normal":
        userModes[senderId] = "normal";
        if (conversations[senderId]) conversations[senderId][0] = SYSTEM_PROMPTS.normal;
        await sendMessage(senderId, "💬 Retour au mode discussion classique.");
        break;

      case "search":
        await sendTypingIndicator(senderId, "typing_on");
        const result = await callGroqCompoundSearch(command.query);
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `🔎 ${result}`);
        break;
    }
  } catch (err) {
    console.error("Erreur handleCommand:", err.message);
    await sendMessage(senderId, "Désolé, une erreur est survenue avec cette commande 🙏");
  }
}

// Recherche web en temps réel via le modèle groq/compound (recherche intégrée côté Groq)
async function callGroqCompoundSearch(query) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "groq/compound",
      messages: [
        {
          role: "system",
          content:
            "Réponds en français, de façon concise et claire, en te basant sur une recherche web à jour.",
        },
        { role: "user", content: query },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Groq compound error: ${JSON.stringify(data)}`);
  }
  return data.choices[0].message.content;
}

// ==== 3ter. Détection d'une demande de génération d'image (mots-clés FR) ====
function detectImageGenerationIntent(text) {
  const pattern =
    /^(g[ée]n[èe]re(?:-moi)?|dessine(?:-moi)?|cr[ée]e?(?:-moi)?|fais(?:-moi)?)\s*(?:une\s*)?(?:image|photo|illustration|dessin)?\s*(?:de|d['’])?\s*(.+)$/i;
  const match = text.trim().match(pattern);
  if (!match) return null;
  const prompt = match[2] ? match[2].trim() : "";
  return prompt.length > 0 ? prompt : null;
}

// ==== 3quater. Générer une image (Pollinations, gratuit, sans clé) et l'envoyer ====
async function handleImageGeneration(senderId, prompt) {
  try {
    await sendTypingIndicator(senderId, "typing_on");

    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;

    const sendResult = await sendImageAttachment(senderId, imageUrl);
    console.log("Résultat envoi image générée:", JSON.stringify(sendResult));

    if (!conversations[senderId]) {
      conversations[senderId] = [SYSTEM_PROMPT];
    }
    conversations[senderId].push({ role: "user", content: `[a demandé une image: ${prompt}]` });
    conversations[senderId].push({ role: "assistant", content: "[a envoyé une image générée]" });

    await sendTypingIndicator(senderId, "typing_off");
  } catch (err) {
    console.error("Erreur handleImageGeneration:", err.message);
    await sendMessage(
      senderId,
      "Désolé, je n'ai pas réussi à générer cette image. Réessaie dans un instant 🙏"
    );
  }
}

// Envoi d'une image (URL publique) via l'API Send de Messenger
async function sendImageAttachment(recipientId, imageUrl) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "image",
          payload: { url: imageUrl, is_reusable: true },
        },
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Erreur sendImageAttachment:", JSON.stringify(data));
  }
  return data;
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

// ==== 3bis. Traitement d'un message contenant une image ====
async function handleImageMessage(senderId, imageUrl) {
  try {
    await sendTypingIndicator(senderId, "typing_on");

    const mode = userModes[senderId] || "normal";
    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.normal;

    if (!conversations[senderId]) {
      conversations[senderId] = [systemPrompt];
    } else {
      conversations[senderId][0] = systemPrompt;
    }
    let history = conversations[senderId];

    const aiReply = await callGroqVision(imageUrl, systemPrompt);
    console.log("Réponse Groq (vision) reçue:", aiReply);

    // On garde une trace en texte simple dans l'historique pour la suite de la conversation
    history.push({ role: "user", content: "[a envoyé une photo]" });
    history.push({ role: "assistant", content: aiReply });
    conversations[senderId] = history;

    if (history.length > MAX_HISTORY + 1) {
      conversations[senderId] = [history[0], ...history.slice(-MAX_HISTORY)];
    }

    await sendTypingIndicator(senderId, "typing_off");
    const sendResult = await sendMessage(senderId, aiReply);
    console.log("Résultat sendMessage (image):", JSON.stringify(sendResult));
  } catch (err) {
    console.error("Erreur handleImageMessage:", err.message);
    await sendMessage(
      senderId,
      "Désolé, je n'ai pas réussi à analyser cette photo. Réessaie dans un instant 🙏"
    );
  }
}

// ==== 4bis. Appel à l'API Groq avec un modèle vision (analyse d'image) ====
async function callGroqVision(imageUrl, systemPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        systemPrompt || SYSTEM_PROMPTS.normal,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Décris cette image et réponds de façon utile et chaleureuse, comme si tu discutais avec la personne qui vient de l'envoyer.",
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.8,
      max_tokens: 500,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Groq vision error: ${JSON.stringify(data)}`);
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
