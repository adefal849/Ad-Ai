// netlify/functions/webhook.js
// Webhook Facebook Messenger + IA Groq + mémoire en RAM
//
// Historique des correctifs :
// - 13/07/2026 : endpoint Send API /{PAGE_ID}/messages + messaging_type obligatoire.
// - 29/09/2026 : modèles texte/vision dépréciés remplacés par des listes de secours
//   + ajout de commandes fun (police stylisée, traducteur, blagues, météo, etc.)
//   + Mode Codeur enrichi avec un vrai référentiel de bonnes pratiques de code.

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAGE_ID = process.env.PAGE_ID;

const GRAPH_API_VERSION = "v25.0";
const MAX_HISTORY = 10;

const GROQ_TEXT_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
const GROQ_VISION_MODELS = ["qwen/qwen3.6-27b", "openai/gpt-oss-120b"];

const SYSTEM_PROMPTS = {
  normal: {
    role: "system",
    content:
      "Tu es Adéfal AI, un assistant conversationnel sympathique et naturel, qui discute librement avec les utilisateurs sur Messenger. Réponds en français par défaut, de façon chaleureuse et concise.",
  },
  coder: {
    role: "system",
    content: `Tu es Adéfal AI en Mode Codeur : un développeur senior rigoureux qui répond sur Messenger (texte brut, pas de rendu markdown élaboré — évite les # de titres et les tableaux, utilise plutôt des tirets et des sauts de ligne clairs).

Règles de bonnes pratiques que tu appliques systématiquement, sans que l'utilisateur ait à les demander :

1. Sécurité d'abord
   - Ne jamais coder en dur des clés API, mots de passe ou secrets — toujours via variables d'environnement.
   - Toujours valider/nettoyer les entrées utilisateur (injection SQL, XSS, etc.).
   - Signaler explicitement un risque de sécurité si tu le repères dans une question ou du code fourni, même si on ne te le demande pas.

2. Code lisible et maintenable
   - Noms de variables et fonctions explicites (pas de x, tmp, data2).
   - Fonctions courtes, une responsabilité par fonction.
   - Commentaires seulement là où le "pourquoi" n'est pas évident — jamais pour paraphraser une ligne triviale.
   - Respecter les conventions idiomatiques du langage utilisé (ex: camelCase en JS, snake_case en Python).

3. Gestion des erreurs
   - Toujours prévoir le cas d'échec (try/catch, vérification de valeurs nulles, réponses API en erreur).
   - Ne jamais avaler une erreur silencieusement sans au moins la logger.

4. Honnêteté technique
   - Si une bibliothèque ou une API a pu changer depuis ta dernière connaissance certaine, le dire clairement plutôt que d'inventer une syntaxe.
   - Si la demande est ambiguë ou risque de casser quelque chose d'existant, poser une question précise avant de sortir du code, plutôt que de deviner.
   - Ne jamais prétendre qu'un code a été testé s'il ne l'a pas été.

5. Complet mais concis
   - Donner du code copiable-collable directement fonctionnel, pas des fragments trop elliptiques.
   - Expliquer en 1-3 phrases le raisonnement clé après le code, pas un roman.
   - Si le fix touche plusieurs fichiers, dire clairement lesquels et pourquoi.

Ton style reste chaleureux et direct, mais tes réponses techniques doivent être celles d'un développeur senior qui pense sécurité, lisibilité et robustesse avant tout.`,
  },
};
const SYSTEM_PROMPT = SYSTEM_PROMPTS.normal;

const conversations = {};
const userModes = {};

const MENU_TEXT =
  "━━━━━━━━━━━━━━━━━━━━\n" +
  "✨  F E M I   A I  ✨\n" +
  "━━━━━━━━━━━━━━━━━━━━\n\n" +
  "📜 Menu principal\n\n" +
  "🆘  help — afficher cette aide\n" +
  "🆔  id — ton identifiant Messenger\n" +
  "🔎  recherche <question> — recherche web en temps réel\n" +
  "🎨  dessine-moi <description> — générer une image\n" +
  "🧑‍💻  mode codeur — bascule en assistant technique (bonnes pratiques intégrées)\n" +
  "💬  mode normal — retour au mode discussion classique\n\n" +
  "✒️ police liste — voir tous les styles disponibles\n" +
  "✒️ police <style> <texte> — styliser un texte\n" +
  "🌍  traduis <langue> <texte> — traduction instantanée\n" +
  "😂  blague — une blague aléatoire\n" +
  "💬  citation — une citation inspirante\n" +
  "🔠  majuscule <texte> — tout en MAJUSCULES\n" +
  "🕶️  leet <texte> — convertir en l33t sp34k\n" +
  "🔄  inverse <texte> — inverser le texte\n" +
  "☀️  meteo <ville> — météo actuelle d'une ville\n\n" +
  "━━━━━━━━━━━━━━━━━━━━\n" +
  "Écris-moi normalement pour discuter, je suis là 🙂";

const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOW = "abcdefghijklmnopqrstuvwxyz".split("");
const DIG = "0123456789".split("");

const FONT_STYLES = {
  gras: {
    label: "Gras",
    upper: "𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙".split(""),
    lower: "𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳".split(""),
    digits: "𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗".split(""),
  },
  italique: {
    label: "Italique",
    upper: "𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍".split(""),
    lower: "𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧".split(""),
    digits: null,
  },
  "gras-italique": {
    label: "Gras Italique",
    upper: "𝑨𝑩𝑪𝑫𝑬𝑭𝑮𝑯𝑰𝑱𝑲𝑳𝑴𝑵𝑶𝑷𝑸𝑹𝑺𝑻𝑼𝑽𝑾𝑿𝒀𝒁".split(""),
    lower: "𝒂𝒃𝒄𝒅𝒆𝒇𝒈𝒉𝒊𝒋𝒌𝒍𝒎𝒏𝒐𝒑𝒒𝒓𝒔𝒕𝒖𝒗𝒘𝒙𝒚𝒛".split(""),
    digits: null,
  },
  script: {
    label: "Script",
    upper: "𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵".split(""),
    lower: "𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏".split(""),
    digits: null,
  },
  double: {
    label: "Double (𝔻𝕠𝕦𝕓𝕝𝕖)",
    upper: "𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ".split(""),
    lower: "𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫".split(""),
    digits: "𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡".split(""),
  },
  gothique: {
    label: "Gothique",
    upper: "𝔄𝔅ℭ𝔇𝔈𝔉𝔊ℌℑ𝔍𝔎𝔏𝔐𝔑𝔒𝔓𝔔ℜ𝔖𝔗𝔘𝔙𝔚𝔛𝔜ℨ".split(""),
    lower: "𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨𝔩𝔪𝔫𝔬𝔭𝔮𝔯𝔰𝔱𝔲𝔳𝔴𝔵𝔶𝔷".split(""),
    digits: null,
  },
  mono: {
    label: "Mono",
    upper: "𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉".split(""),
    lower: "𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣".split(""),
    digits: "𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿".split(""),
  },
  bulle: {
    label: "Bulle",
    upper: "ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ".split(""),
    lower: "ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ".split(""),
    digits: "⓪①②③④⑤⑥⑦⑧⑨".split(""),
  },
};

function styleText(text, styleKey) {
  const style = FONT_STYLES[styleKey];
  if (!style) return null;
  return text
    .split("")
    .map((ch) => {
      const iUp = UP.indexOf(ch);
      if (iUp !== -1) return style.upper[iUp] || ch;
      const iLow = LOW.indexOf(ch);
      if (iLow !== -1) return style.lower[iLow] || ch;
      const iDig = DIG.indexOf(ch);
      if (iDig !== -1) return (style.digits && style.digits[iDig]) || ch;
      return ch;
    })
    .join("");
}

function stylesListText() {
  const examples = Object.entries(FONT_STYLES)
    .map(([key, s]) => `• ${key} → ${styleText("Adefal", key)}`)
    .join("\n");
  return `✒️ Styles disponibles :\n\n${examples}\n\n➡️ Exemple : "police gras salut tout le monde"`;
}

const FLIP_MAP = {
  a: "ɐ", b: "q", c: "ɔ", d: "p", e: "ǝ", f: "ɟ", g: "ƃ", h: "ɥ", i: "ᴉ",
  j: "ɾ", k: "ʞ", l: "l", m: "ɯ", n: "u", o: "o", p: "d", q: "b", r: "ɹ",
  s: "s", t: "ʇ", u: "n", v: "ʌ", w: "ʍ", x: "x", y: "ʎ", z: "z",
  A: "∀", B: "B", C: "Ɔ", D: "D", E: "Ǝ", F: "Ⅎ", G: "⅁", H: "H", I: "I",
  J: "ſ", K: "K", L: "˥", M: "W", N: "N", O: "O", P: "Ԁ", Q: "Q", R: "ᴚ",
  S: "S", T: "⊥", U: "∩", V: "Λ", W: "M", X: "X", Y: "⅄", Z: "Z",
  "0": "0", "1": "Ɩ", "2": "ᄅ", "3": "Ɛ", "4": "ㄣ", "5": "5", "6": "9",
  "7": "ㄥ", "8": "8", "9": "6", ".": "˙", ",": "'", "?": "¿", "!": "¡",
  "'": ",", "(": ")", ")": "(", "[": "]", "]": "[",
};
function flipText(text) {
  return text.split("").reverse().map((ch) => FLIP_MAP[ch] || ch).join("");
}

const LEET_MAP = { a: "4", e: "3", i: "1", o: "0", s: "5", t: "7", A: "4", E: "3", I: "1", O: "0", S: "5", T: "7" };
function leetText(text) {
  return text.split("").map((ch) => LEET_MAP[ch] || ch).join("");
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    if (params["hub.mode"] === "subscribe" && params["hub.verify_token"] === VERIFY_TOKEN) {
      return { statusCode: 200, body: params["hub.challenge"] };
    }
    return { statusCode: 403, body: "Verification failed" };
  }

  if (event.httpMethod === "POST") {
    const body = JSON.parse(event.body);

    if (body.object === "page") {
      for (const entry of body.entry) {
        const webhookEvent = entry.messaging?.[0];
        if (!webhookEvent) continue;

        const senderId = webhookEvent.sender.id;

        if (webhookEvent.message && webhookEvent.message.text) {
          const userText = webhookEvent.message.text;
          const command = parseCommand(userText);
          if (command) {
            await handleCommand(senderId, command);
          } else {
            const imagePrompt = detectImageGenerationIntent(userText);
            if (imagePrompt) {
              await handleImageGeneration(senderId, imagePrompt);
            } else {
              await handleMessage(senderId, userText);
            }
          }
        } else if (webhookEvent.message?.attachments?.some((a) => a.type === "image")) {
          const imageAttachment = webhookEvent.message.attachments.find((a) => a.type === "image");
          await handleImageMessage(senderId, imageAttachment.payload.url);
        }
      }
      return { statusCode: 200, body: "EVENT_RECEIVED" };
    }
    return { statusCode: 404, body: "Not Found" };
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

async function handleMessage(senderId, userText) {
  try {
    await sendTypingIndicator(senderId, "typing_on");
    const mode = userModes[senderId] || "normal";
    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.normal;

    if (!conversations[senderId]) conversations[senderId] = [systemPrompt];
    else conversations[senderId][0] = systemPrompt;

    let history = conversations[senderId];
    history.push({ role: "user", content: userText });
    if (history.length > MAX_HISTORY + 1) history = [history[0], ...history.slice(-MAX_HISTORY)];

    const aiReply = await callGroqWithFallback(history);
    history.push({ role: "assistant", content: aiReply });
    conversations[senderId] = history;

    await sendTypingIndicator(senderId, "typing_off");
    await sendMessage(senderId, aiReply);
  } catch (err) {
    console.error("Erreur handleMessage:", err.message);
    await sendMessage(senderId, "Désolé, j'ai eu un souci technique. Réessaie dans un instant 🙏");
  }
}

function parseCommand(text) {
  const t = text.trim().toLowerCase();

  if (t === "menu" || t === "/menu") return { type: "menu" };
  if (t === "help" || t === "/help" || t === "aide") return { type: "help" };
  if (t === "id" || t === "/id" || t === "mon id") return { type: "id" };
  if (t === "mode codeur" || t === "/coder" || t === "mode coder") return { type: "mode_coder" };
  if (t === "mode normal" || t === "/normal") return { type: "mode_normal" };
  if (t === "blague" || t === "/blague") return { type: "blague" };
  if (t === "citation" || t === "/citation") return { type: "citation" };

  const searchMatch = text.trim().match(/^(?:\/recherche|recherche|\/search|search)\s+(.+)$/i);
  if (searchMatch) return { type: "search", query: searchMatch[1].trim() };

  if (t === "police liste" || t === "police" || t === "/police") return { type: "police_liste" };
  const policeMatch = text.trim().match(/^police\s+(\S+)\s+(.+)$/i);
  if (policeMatch) return { type: "police", style: policeMatch[1].toLowerCase(), text: policeMatch[2] };

  const traduisMatch = text.trim().match(/^traduis\s+(?:en\s+)?(\S+)\s+(.+)$/i);
  if (traduisMatch) return { type: "traduis", langue: traduisMatch[1], text: traduisMatch[2] };

  const majMatch = text.trim().match(/^majuscule\s+(.+)$/i);
  if (majMatch) return { type: "majuscule", text: majMatch[1] };

  const leetMatch = text.trim().match(/^leet\s+(.+)$/i);
  if (leetMatch) return { type: "leet", text: leetMatch[1] };

  const inverseMatch = text.trim().match(/^inverse\s+(.+)$/i);
  if (inverseMatch) return { type: "inverse", text: inverseMatch[1] };

  const meteoMatch = text.trim().match(/^meteo\s+(.+)$/i) || text.trim().match(/^météo\s+(.+)$/i);
  if (meteoMatch) return { type: "meteo", ville: meteoMatch[1].trim() };

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
          `🆔 Ton identifiant Messenger (PSID) :\n${senderId}\n\nℹ️ Meta ne permet pas de relier cet identifiant à ton vrai nom ou profil public.`
        );
        break;

      case "mode_coder":
        userModes[senderId] = "coder";
        if (conversations[senderId]) conversations[senderId][0] = SYSTEM_PROMPTS.coder;
        await sendMessage(
          senderId,
          "🧑‍💻 Mode Codeur activé — je vais coder proprement : sécurité, lisibilité, gestion d'erreurs. Écris 'mode normal' pour revenir."
        );
        break;

      case "mode_normal":
        userModes[senderId] = "normal";
        if (conversations[senderId]) conversations[senderId][0] = SYSTEM_PROMPTS.normal;
        await sendMessage(senderId, "💬 Retour au mode discussion classique.");
        break;

      case "search": {
        await sendTypingIndicator(senderId, "typing_on");
        const result = await callGroqCompoundSearch(command.query);
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `🔎 ${result}`);
        break;
      }

      case "police_liste":
        await sendMessage(senderId, stylesListText());
        break;

      case "police": {
        const styled = styleText(command.text, command.style);
        if (!styled) {
          await sendMessage(senderId, `Style "${command.style}" inconnu. Écris "police liste" pour voir les styles.`);
        } else {
          await sendMessage(senderId, styled);
        }
        break;
      }

      case "traduis": {
        await sendTypingIndicator(senderId, "typing_on");
        const translated = await translateText(command.text, command.langue);
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `🌍 ${translated}`);
        break;
      }

      case "blague": {
        await sendTypingIndicator(senderId, "typing_on");
        const joke = await generateFun("blague courte et drôle en français, avec chute");
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `😂 ${joke}`);
        break;
      }

      case "citation": {
        await sendTypingIndicator(senderId, "typing_on");
        const quote = await generateFun("citation inspirante courte en français, avec son auteur si connu");
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `💬 ${quote}`);
        break;
      }

      case "majuscule":
        await sendMessage(senderId, command.text.toUpperCase());
        break;

      case "leet":
        await sendMessage(senderId, leetText(command.text));
        break;

      case "inverse":
        await sendMessage(senderId, flipText(command.text));
        break;

      case "meteo": {
        await sendTypingIndicator(senderId, "typing_on");
        const meteo = await getWeather(command.ville);
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `☀️ ${meteo}`);
        break;
      }
    }
  } catch (err) {
    console.error("Erreur handleCommand:", err.message);
    await sendMessage(senderId, "Désolé, une erreur est survenue avec cette commande 🙏");
  }
}

async function translateText(text, langue) {
  const messages = [
    {
      role: "system",
      content: `Tu es un traducteur. Traduis le texte de l'utilisateur vers la langue "${langue}". Réponds UNIQUEMENT avec la traduction, sans aucune explication ni guillemets.`,
    },
    { role: "user", content: text },
  ];
  return await callGroqWithFallback(messages);
}

async function generateFun(instruction) {
  const messages = [
    { role: "system", content: `Génère une seule ${instruction}. Réponds uniquement avec le contenu, sans préambule.` },
    { role: "user", content: "Vas-y" },
  ];
  return await callGroqWithFallback(messages, 1.0);
}

async function getWeather(ville) {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(ville)}?format=3&lang=fr&M`, {
      headers: { "User-Agent": "curl/8.0" },
    });
    const text = await res.text();
    if (!res.ok || !text || text.includes("Unknown location")) {
      return `Ville "${ville}" introuvable. Vérifie l'orthographe.`;
    }
    return text.trim();
  } catch (err) {
    console.error("Erreur getWeather:", err.message);
    return "Impossible de récupérer la météo pour le moment.";
  }
}

function detectImageGenerationIntent(text) {
  const pattern =
    /^(g[ée]n[èe]re(?:-moi)?|dessine(?:-moi)?|cr[ée]e?(?:-moi)?|fais(?:-moi)?)\s*(?:une\s*)?(?:image|photo|illustration|dessin)?\s*(?:de|d['’])?\s*(.+)$/i;
  const match = text.trim().match(pattern);
  if (!match) return null;
  const prompt = match[2] ? match[2].trim() : "";
  return prompt.length > 0 ? prompt : null;
}

async function handleImageGeneration(senderId, prompt) {
  try {
    await sendTypingIndicator(senderId, "typing_on");
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
    await sendImageAttachment(senderId, imageUrl);

    if (!conversations[senderId]) conversations[senderId] = [SYSTEM_PROMPT];
    conversations[senderId].push({ role: "user", content: `[a demandé une image: ${prompt}]` });
    conversations[senderId].push({ role: "assistant", content: "[a envoyé une image générée]" });

    await sendTypingIndicator(senderId, "typing_off");
  } catch (err) {
    console.error("Erreur handleImageGeneration:", err.message);
    await sendMessage(senderId, "Désolé, je n'ai pas réussi à générer cette image 🙏");
  }
}

async function sendImageAttachment(recipientId, imageUrl) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } },
    }),
  });
  const data = await res.json();
  if (!res.ok) console.error("Erreur sendImageAttachment:", JSON.stringify(data));
  return data;
}

async function callGroqCompoundSearch(query) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "groq/compound",
      messages: [
        { role: "system", content: "Réponds en français, de façon concise et claire, en te basant sur une recherche web à jour." },
        { role: "user", content: query },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Groq compound error: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

async function callGroqWithFallback(messages, temperature = 0.8) {
  let lastError;
  for (const model of GROQ_TEXT_MODELS) {
    try {
      return await callGroq(messages, model, temperature);
    } catch (err) {
      console.error(`Modèle texte ${model} indisponible:`, err.message);
      lastError = err;
    }
  }
  throw lastError;
}

async function callGroq(messages, model, temperature = 0.8) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: 500 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Groq error (${model}): ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

async function handleImageMessage(senderId, imageUrl) {
  try {
    await sendTypingIndicator(senderId, "typing_on");
    const mode = userModes[senderId] || "normal";
    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.normal;

    if (!conversations[senderId]) conversations[senderId] = [systemPrompt];
    else conversations[senderId][0] = systemPrompt;

    let history = conversations[senderId];
    const aiReply = await callGroqVisionWithFallback(imageUrl, systemPrompt);

    history.push({ role: "user", content: "[a envoyé une photo]" });
    history.push({ role: "assistant", content: aiReply });
    conversations[senderId] = history;
    if (history.length > MAX_HISTORY + 1) conversations[senderId] = [history[0], ...history.slice(-MAX_HISTORY)];

    await sendTypingIndicator(senderId, "typing_off");
    await sendMessage(senderId, aiReply);
  } catch (err) {
    console.error("Erreur handleImageMessage:", err.message);
    await sendMessage(senderId, "Désolé, je n'ai pas réussi à analyser cette photo 🙏");
  }
}

async function callGroqVisionWithFallback(imageUrl, systemPrompt) {
  let lastError;
  for (const model of GROQ_VISION_MODELS) {
    try {
      return await callGroqVision(imageUrl, systemPrompt, model);
    } catch (err) {
      console.error(`Modèle vision ${model} indisponible:`, err.message);
      lastError = err;
    }
  }
  throw lastError;
}

async function callGroqVision(imageUrl, systemPrompt, model) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        systemPrompt || SYSTEM_PROMPTS.normal,
        {
          role: "user",
          content: [
            { type: "text", text: "Décris cette image et réponds de façon utile et chaleureuse." },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.8,
      max_tokens: 500,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Groq vision error (${model}): ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

async function sendMessage(recipientId, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { text } }),
  });
  const data = await res.json();
  if (!res.ok) console.error("Erreur sendMessage:", JSON.stringify(data));
  return data;
}

async function sendTypingIndicator(recipientId, action) {
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action }),
    });
    const data = await res.json();
    if (!res.ok) console.error("Erreur typing indicator:", JSON.stringify(data));
  } catch (err) {
    console.error("Erreur typing indicator (catch):", err.message);
  }
}
