// netlify/functions/webhook.js
// Webhook Facebook Messenger + IA Groq + mémoire en RAM
//
// Historique des correctifs :
// - 13/07/2026 : endpoint Send API /{PAGE_ID}/messages + messaging_type obligatoire.
// - 29/09/2026 : modèles dépréciés remplacés + commandes fun + Mode Codeur enrichi
//   + génération de fichiers HTML/CSS/JS/ZIP.
// - 02/10/2026 : regex multi-lignes, découpage auto > 2000 car., Array.from() pour
//   les polices Unicode, modèles vision corrigés, suivi de question sur image,
//   repli de la recherche web, calcul/definition/resume.
// - 09/10/2026 :
//   1) Identité : le bot répond que son créateur est Adéfal (et non OpenAI/Groq/Meta).
//   2) Mode Codeur : vraie base de connaissances intégrée (HTML, CSS, JS, bonnes
//      pratiques, sécurité, débogage) + plus de place pour répondre (max_tokens 3000).
//   3) Nouvelles commandes : "cours" (cours HTML/CSS/JS fiables, écrits en dur, et
//      cours générés pour git/sql/python/react/node/api/securite/php) et
//      "dev <question>" (question de code avec l'expertise du Mode Codeur, quel que
//      soit le mode actif).

const JSZip = require("jszip");

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAGE_ID = process.env.PAGE_ID;

const GRAPH_API_VERSION = "v25.0";
const MAX_HISTORY = 10;
const MESSENGER_TEXT_LIMIT = 2000;

const GROQ_TEXT_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
// openai/gpt-oss-120b n'a PAS de capacité vision : seuls les modèles Qwen ci-dessous l'ont.
const GROQ_VISION_MODELS = ["qwen/qwen3.6-27b", "qwen/qwen3.8-27b"];

// ==== Identité du bot (commune aux deux modes) ====
const IDENTITY = [
  "Identité : tu es Adéfal AI. Ton créateur est Adéfal, le développeur qui t'a conçu, assemblé et configuré.",
  "Si on te demande qui t'a créé, qui est ton créateur ou ton développeur, réponds : Adéfal.",
  "Ne dis jamais que tu as été créé par OpenAI, Meta, Groq, Alibaba, Google ou une autre entreprise.",
  "Si on te demande sur quelle technologie tu fonctionnes, réponds honnêtement que tu fonctionnes grâce à des modèles de langage ouverts, assemblés et configurés par Adéfal, sans prétendre les avoir entraînés toi-même.",
  "Tu es une IA : tu n'as pas de vie privée réelle (pas de conjoint, pas de famille, pas de corps). N'invente JAMAIS de fausse information personnelle présentée comme un fait réel (pas de faux nom de conjoint(e), d'enfants, etc.) ; réponds avec humour en clarifiant que tu es une IA.",
].join(" ");

// ==== Base de connaissances de codage (intégrée au Mode Codeur) ====
const CODING_KNOWLEDGE = [
  "BASE DE CONNAISSANCES QUE TU MAÎTRISES (tu t'en sers pour enseigner et pour coder) :",
  "",
  "HTML — squelette : <!DOCTYPE html>, <html lang=\"fr\">, <head> (<meta charset=\"UTF-8\">, <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">, <title>, <link rel=\"stylesheet\" href=\"style.css\">), <body>, <script src=\"script.js\"></script> en fin de body.",
  "HTML — balises : titres h1-h6 ; p ; a href ; strong ; em ; br ; hr ; span ; div ; sémantiques header, nav, main, section, article, aside, footer ; listes ul/ol/li ; img src alt ; video/audio controls ; table/tr/th/td ; formulaires form, label, input (text, email, password, number, checkbox, radio), textarea, select/option, button.",
  "HTML — règles : alt sur les images, un seul h1 par page, balises sémantiques plutôt que des div partout, label lié à chaque input, lang sur html.",
  "",
  "CSS — syntaxe : selecteur { propriete: valeur; }. Sélecteurs : balise, .classe, #id, :hover, descendant (ul li), enfant (ul > li).",
  "CSS — propriétés clés : color, background, font-family, font-size, font-weight, text-align, line-height, margin, padding, border, border-radius, box-shadow, width, height, max-width, overflow, opacity, cursor, transition, transform, animation + @keyframes.",
  "CSS — mise en page : display flex (flex-direction, justify-content, align-items, gap, flex-wrap), display grid (grid-template-columns: repeat(3, 1fr), gap), position relative/absolute/fixed/sticky, z-index, @media (max-width: 600px) pour le responsive, mobile-first.",
  "CSS — règles : * { box-sizing: border-box; }, variables CSS (--couleur: #333; var(--couleur)), classes réutilisables, éviter !important.",
  "",
  "JavaScript — bases : const/let (jamais var), types (string, number, boolean, null, undefined, array, object), fonctions (function et flèches =>), if/else, for, for...of, ===, template strings.",
  "JavaScript — tableaux/objets : push, pop, map, filter, find, includes, reduce, length ; destructuring ; spread (...).",
  "JavaScript — DOM : document.querySelector, addEventListener('click', ...), textContent, classList.add/remove/toggle, value, createElement, appendChild.",
  "JavaScript — asynchrone : fetch + async/await + try/catch, res.json(), JSON.stringify/parse, localStorage.getItem/setItem.",
  "",
  "AUTRES SUJETS que tu sais enseigner : Git (init, add, commit, branch, merge, pull request), SQL (SELECT, WHERE, JOIN, INSERT, UPDATE, DELETE, index), Python (bases, listes, dictionnaires, fonctions), Node.js/Express (routes GET/POST, middleware, variables d'environnement), React (composants, props, useState, useEffect), API REST (méthodes, codes HTTP 200/201/400/401/403/404/500), PHP (bases).",
  "",
  "SÉCURITÉ À RAPPELER : variables d'environnement pour les secrets, jamais de clé dans le code ni dans un dépôt public ; valider et échapper les entrées utilisateur (XSS, injection SQL) ; requêtes préparées ; HTTPS ; mots de passe hachés (bcrypt/argon2) ; ne jamais faire confiance au client.",
  "DÉBOGAGE : reproduire le bug, lire le message d'erreur en entier, isoler par bissection, console.log ciblés, vérifier les types et les valeurs nulles.",
  "",
  "FORMAT POUR MESSENGER : Messenger n'affiche PAS le markdown (pas de gras, pas de # titres, pas de rendu de bloc de code). Entoure toujours le code de lignes contenant uniquement trois accents graves (```) pour le délimiter visuellement, indente avec 2 espaces, et écris le reste en texte simple. Si le code dépasse environ 40 lignes, propose à l'utilisateur d'utiliser la commande 'fichier html', 'fichier css', 'fichier js' ou 'zip <description>' pour recevoir un vrai fichier.",
].join("\n");

const CODER_RULES = [
  "Tu es Adéfal AI en Mode Codeur : un développeur senior rigoureux, pédagogue et patient, qui répond sur Messenger.",
  "",
  "Règles de bonnes pratiques que tu appliques systématiquement :",
  "1. Sécurité d'abord — jamais de clés/mots de passe en dur, toujours valider les entrées utilisateur.",
  "2. Code lisible — noms explicites, fonctions courtes, commentaires seulement si le \"pourquoi\" n'est pas évident.",
  "3. Gestion des erreurs — try/catch systématique, jamais d'erreur avalée silencieusement.",
  "4. Honnêteté technique — signale si une API a pu changer, pose une question plutôt que de deviner en cas d'ambiguïté, ne prétends jamais qu'un code a été testé s'il ne l'a pas été.",
  "5. Concis mais complet — du code copiable-collable directement fonctionnel, puis 1 à 3 phrases d'explication.",
  "",
  "Réflexes de développeur senior :",
  "- Débogage méthodique : reproduire, isoler, lire l'erreur en entier avant de chercher ailleurs.",
  "- Ne jamais optimiser avant d'avoir mesuré.",
  "- Un commit = un changement logique, avec un message qui explique le \"pourquoi\".",
  "- Toujours garder un chemin de retour arrière (rollback) avant de déployer un changement risqué.",
  "- Se méfier du code non testé, même généré par une IA — y compris le tien.",
  "",
  "Quand l'utilisateur débute, explique simplement, avec un exemple court. Ton style reste chaleureux et direct.",
].join("\n");

const SYSTEM_PROMPTS = {
  normal: {
    role: "system",
    content:
      "Tu es Adéfal AI, un assistant conversationnel sympathique et naturel, qui discute librement avec les utilisateurs sur Messenger. Réponds en français par défaut, de façon chaleureuse et concise.\n\n" +
      IDENTITY,
  },
  coder: {
    role: "system",
    content: CODER_RULES + "\n\n" + CODING_KNOWLEDGE + "\n\n" + IDENTITY,
  },
};
const SYSTEM_PROMPT = SYSTEM_PROMPTS.normal;

const conversations = {};
const userModes = {};
const lastImageUrl = {}; // senderId -> URL de la dernière photo envoyée (pour les questions de suivi)

// ==== Cours écrits en dur (fiables, sans risque d'hallucination) ====
const COURS_HTML = [
  "📘 COURS HTML — les balises essentielles",
  "",
  "🏗️ Squelette d'une page :",
  "```",
  "<!DOCTYPE html>",
  "<html lang=\"fr\">",
  "<head>",
  "  <meta charset=\"UTF-8\">",
  "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
  "  <title>Ma page</title>",
  "  <link rel=\"stylesheet\" href=\"style.css\">",
  "</head>",
  "<body>",
  "  ...contenu...",
  "  <script src=\"script.js\"></script>",
  "</body>",
  "</html>",
  "```",
  "",
  "📝 Texte : <h1> à <h6> titres, <p> paragraphe, <a href=\"...\"> lien, <strong> gras, <em> italique, <br> retour à la ligne, <hr> ligne, <span> texte en ligne",
  "🧱 Structure : <header> <nav> <main> <section> <article> <aside> <footer> <div>",
  "📋 Listes : <ul> puces, <ol> numérotée, <li> élément",
  "🖼️ Médias : <img src=\"\" alt=\"\"> <video controls> <audio controls>",
  "🧾 Formulaires : <form> <label> <input type=\"text | email | password | number | checkbox | radio\"> <textarea> <select><option> <button>",
  "📊 Tableaux : <table> <tr> ligne, <th> titre, <td> cellule",
  "",
  "✅ Bonnes pratiques : toujours un alt sur les images, un seul <h1> par page, balises sémantiques (header, main, footer) plutôt que des <div> partout, lang=\"fr\" sur <html>.",
  "",
  "➡️ Écris 'cours css' pour la suite.",
].join("\n");

const COURS_CSS = [
  "🎨 COURS CSS — habiller ta page",
  "",
  "Syntaxe :",
  "```",
  "selecteur {",
  "  propriete: valeur;",
  "}",
  "```",
  "",
  "🎯 Sélecteurs : p (balise), .classe, #identifiant, a:hover (survol), ul li (descendant)",
  "🔤 Texte : color, font-size, font-family, font-weight, text-align, line-height",
  "📦 Boîte : width, height, margin (extérieur), padding (intérieur), border, border-radius, box-shadow",
  "🌈 Fond : background-color, background-image, linear-gradient(...)",
  "📐 Mise en page :",
  "```",
  ".conteneur {",
  "  display: flex;",
  "  justify-content: center;",
  "  align-items: center;",
  "  gap: 16px;",
  "}",
  "```",
  "Grille : display: grid; grid-template-columns: repeat(3, 1fr);",
  "📍 Position : relative, absolute, fixed, sticky + top/left/right/bottom + z-index",
  "✨ Animation : transition: all 0.3s ease; puis @keyframes + animation",
  "📱 Responsive :",
  "```",
  "@media (max-width: 600px) {",
  "  .conteneur { flex-direction: column; }",
  "}",
  "```",
  "",
  "💡 Astuce : * { box-sizing: border-box; } évite beaucoup de problèmes de tailles. Utilise des variables : --couleur: #333; puis var(--couleur).",
  "",
  "➡️ Écris 'cours js' pour la suite.",
].join("\n");

const COURS_JS = [
  "⚙️ COURS JAVASCRIPT — les bases",
  "",
  "📦 Variables : const (ne change pas) et let (change). Évite var.",
  "🔢 Types : string, number, boolean, null, undefined, array [], object {}",
  "🧮 Fonctions :",
  "```",
  "function addition(a, b) {",
  "  return a + b;",
  "}",
  "const double = (n) => n * 2;",
  "```",
  "🔀 Conditions : if (x > 5) { ... } else { ... }  (utilise === plutôt que ==)",
  "🔁 Boucles : for (let i = 0; i < 5; i++) { ... }  ou  for (const el of tableau) { ... }",
  "📚 Tableaux : push, pop, map, filter, find, includes, length",
  "🌐 DOM (modifier la page) :",
  "```",
  "const btn = document.querySelector('#btn');",
  "btn.addEventListener('click', () => {",
  "  document.querySelector('h1').textContent = 'Salut !';",
  "});",
  "```",
  "📡 Appeler une API :",
  "```",
  "async function charger() {",
  "  try {",
  "    const res = await fetch('https://api.exemple.com/data');",
  "    const data = await res.json();",
  "    console.log(data);",
  "  } catch (e) {",
  "    console.error(e);",
  "  }",
  "}",
  "```",
  "",
  "✅ Bonnes pratiques : toujours un try/catch autour de fetch, ne jamais mettre de clé secrète dans le code, noms de variables explicites.",
].join("\n");

const COURS_STATIC = { html: COURS_HTML, css: COURS_CSS, js: COURS_JS };

const COURS_GENERES = {
  git: "Git",
  sql: "SQL",
  python: "Python",
  react: "React",
  node: "Node.js et Express",
  api: "les API REST",
  securite: "la sécurité informatique pour développeurs web",
  php: "PHP",
};

const COURS_LISTE =
  "📚 COURS DISPONIBLES\n\n" +
  "📘 cours html — les balises essentielles\n" +
  "🎨 cours css — le style et la mise en page\n" +
  "⚙️ cours js — JavaScript de base\n" +
  "🧠 cours git | sql | python | react | node | api | securite | php\n\n" +
  "💡 Pour une question de code précise : dev <ta question>\n" +
  "📄 Pour recevoir du vrai code en fichier : fichier html|css|js <description>";

const MENU_TEXT =
  "━━━━━━━━━━━━━━━━━━━━\n" +
  "✨  F E M I   A I  ✨\n" +
  "━━━━━━━━━━━━━━━━━━━━\n\n" +
  "💬 DISCUSSION\n" +
  "🆘 help — cette aide\n" +
  "🆔 id — ton identifiant Messenger\n" +
  "🔎 recherche <question> — recherche web\n" +
  "🧑‍💻 mode codeur / 💬 mode normal\n\n" +
  "🎓 APPRENDRE À CODER\n" +
  "📚 cours — liste des cours (html, css, js...)\n" +
  "🧑‍💻 dev <question> — question de code\n\n" +
  "🎨 CRÉATION\n" +
  "🖼️ dessine-moi <description> — image\n" +
  "📄 fichier html|css|js <description>\n" +
  "🗜️ zip <description> — mini site zippé\n\n" +
  "🧰 OUTILS\n" +
  "🧮 calcul <expression>\n" +
  "📖 definition <mot>\n" +
  "✂️ resume <texte>\n" +
  "🌍 traduis <langue> <texte>\n" +
  "☀️ meteo <ville>\n\n" +
  "🎉 FUN\n" +
  "✒️ police liste / police <style> <texte>\n" +
  "😂 blague — 💬 citation\n" +
  "🔠 majuscule / 🕶️ leet / 🔄 inverse <texte>\n\n" +
  "━━━━━━━━━━━━━━━━━━━━\n" +
  "Écris-moi normalement pour discuter 🙂";

const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOW = "abcdefghijklmnopqrstuvwxyz".split("");
const DIG = "0123456789".split("");

// IMPORTANT : Array.from() et non .split("") — plusieurs de ces styles utilisent
// des caractères Unicode hors du plan de base (paires de substituts).
const FONT_STYLES = {
  gras: {
    upper: Array.from("𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙"),
    lower: Array.from("𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳"),
    digits: Array.from("𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗"),
  },
  italique: {
    upper: Array.from("𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍"),
    lower: Array.from("𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧"),
    digits: null,
  },
  "gras-italique": {
    upper: Array.from("𝑨𝑩𝑪𝑫𝑬𝑭𝑮𝑯𝑰𝑱𝑲𝑳𝑴𝑵𝑶𝑷𝑸𝑹𝑺𝑻𝑼𝑽𝑾𝑿𝒀𝒁"),
    lower: Array.from("𝒂𝒃𝒄𝒅𝒆𝒇𝒈𝒉𝒊𝒋𝒌𝒍𝒎𝒏𝒐𝒑𝒒𝒓𝒔𝒕𝒖𝒗𝒘𝒙𝒚𝒛"),
    digits: null,
  },
  script: {
    upper: Array.from("𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵"),
    lower: Array.from("𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏"),
    digits: null,
  },
  double: {
    upper: Array.from("𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ"),
    lower: Array.from("𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫"),
    digits: Array.from("𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡"),
  },
  gothique: {
    upper: Array.from("𝔄𝔅ℭ𝔇𝔈𝔉𝔊ℌℑ𝔍𝔎𝔏𝔐𝔑𝔒𝔓𝔔ℜ𝔖𝔗𝔘𝔙𝔚𝔛𝔜ℨ"),
    lower: Array.from("𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨𝔩𝔪𝔫𝔬𝔭𝔮𝔯𝔰𝔱𝔲𝔳𝔴𝔵𝔶𝔷"),
    digits: null,
  },
  mono: {
    upper: Array.from("𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉"),
    lower: Array.from("𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣"),
    digits: Array.from("𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿"),
  },
  bulle: {
    upper: Array.from("ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ"),
    lower: Array.from("ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ"),
    digits: Array.from("⓪①②③④⑤⑥⑦⑧⑨"),
  },
};

function styleText(text, styleKey) {
  const style = FONT_STYLES[styleKey];
  if (!style) return null;
  return Array.from(text)
    .map((ch) => {
      if (ch === "\n") return ch;
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
  const examples = Object.keys(FONT_STYLES)
    .map((key) => `• ${key} → ${styleText("Adefal", key)}`)
    .join("\n");
  return `✒️ Styles disponibles :\n\n${examples}\n\n➡️ Exemple : "police gras salut tout le monde"\n(fonctionne aussi avec un texte sur plusieurs lignes)`;
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
  return Array.from(text).reverse().map((ch) => FLIP_MAP[ch] || ch).join("");
}

const LEET_MAP = { a: "4", e: "3", i: "1", o: "0", s: "5", t: "7", A: "4", E: "3", I: "1", O: "0", S: "5", T: "7" };
function leetText(text) {
  return Array.from(text).map((ch) => LEET_MAP[ch] || ch).join("");
}

// ==== Calculatrice sécurisée (sans eval/Function) ====
function safeCalculate(expr) {
  const tokens = expr.match(/\d+(\.\d+)?|\+|-|\*|\/|\(|\)/g);
  if (!tokens) throw new Error("Expression invalide");
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseExpr() {
    let val = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const rhs = parseTerm();
      val = op === "+" ? val + rhs : val - rhs;
    }
    return val;
  }
  function parseTerm() {
    let val = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const rhs = parseFactor();
      val = op === "*" ? val * rhs : val / rhs;
    }
    return val;
  }
  function parseFactor() {
    if (peek() === "(") {
      consume();
      const val = parseExpr();
      if (peek() !== ")") throw new Error("Parenthèse manquante");
      consume();
      return val;
    }
    if (peek() === "-") {
      consume();
      return -parseFactor();
    }
    const token = consume();
    const num = parseFloat(token);
    if (token === undefined || isNaN(num)) throw new Error("Nombre invalide");
    return num;
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("Expression invalide");
  return result;
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
    const maxTokens = mode === "coder" ? 3000 : 1500;

    // Si une photo vient d'être envoyée, on considère ce message comme une
    // question de suivi dessus (une seule fois, puis on efface le contexte image).
    if (lastImageUrl[senderId]) {
      const imageUrl = lastImageUrl[senderId];
      delete lastImageUrl[senderId];
      const aiReply = await callGroqVisionWithFallback(imageUrl, systemPrompt, userText);

      if (!conversations[senderId]) conversations[senderId] = [systemPrompt];
      conversations[senderId].push({ role: "user", content: userText });
      conversations[senderId].push({ role: "assistant", content: aiReply });

      await sendTypingIndicator(senderId, "typing_off");
      await sendMessage(senderId, aiReply);
      return;
    }

    if (!conversations[senderId]) conversations[senderId] = [systemPrompt];
    else conversations[senderId][0] = systemPrompt;

    let history = conversations[senderId];
    history.push({ role: "user", content: userText });
    if (history.length > MAX_HISTORY + 1) history = [history[0], ...history.slice(-MAX_HISTORY)];

    const aiReply = await callGroqWithFallback(history, 0.8, maxTokens);
    history.push({ role: "assistant", content: aiReply });
    conversations[senderId] = history;

    await sendTypingIndicator(senderId, "typing_off");
    await sendMessage(senderId, aiReply);
  } catch (err) {
    console.error("Erreur handleMessage:", err.message);
    await sendMessage(senderId, "Désolé, j'ai eu un souci technique. Réessaie dans un instant 🙏");
  }
}

function normalizeCoursTopic(raw) {
  const t = raw.toLowerCase();
  if (t === "javascript") return "js";
  if (t === "sécurité") return "securite";
  return t;
}

function parseCommand(text) {
  const trimmed = text.trim();
  const t = trimmed.toLowerCase();

  if (t === "menu" || t === "/menu") return { type: "menu" };
  if (t === "help" || t === "/help" || t === "aide") return { type: "help" };
  if (t === "id" || t === "/id" || t === "mon id") return { type: "id" };
  if (t === "mode codeur" || t === "/coder" || t === "mode coder") return { type: "mode_coder" };
  if (t === "mode normal" || t === "/normal") return { type: "mode_normal" };
  if (t === "blague" || t === "/blague") return { type: "blague" };
  if (t === "citation" || t === "/citation") return { type: "citation" };
  if (t === "cours" || t === "/cours") return { type: "cours_liste" };

  // Le sujet est limité à une liste connue pour ne pas intercepter une phrase
  // normale qui commencerait par "cours" (ex : "cours de maths demain").
  const coursMatch = trimmed.match(
    /^\/?cours\s+(html|css|js|javascript|git|sql|python|react|node|api|securite|sécurité|php)\s*$/i
  );
  if (coursMatch) return { type: "cours", topic: normalizeCoursTopic(coursMatch[1]) };

  const devMatch = trimmed.match(/^(?:\/code|dev)\s+(.+)$/is);
  if (devMatch) return { type: "dev", question: devMatch[1].trim() };

  const searchMatch = trimmed.match(/^(?:\/recherche|recherche|\/search|search)\s+(.+)$/is);
  if (searchMatch) return { type: "search", query: searchMatch[1].trim() };

  if (t === "police liste" || t === "police" || t === "/police") return { type: "police_liste" };
  const policeMatch = trimmed.match(/^police\s+(\S+)\s+(.+)$/is);
  if (policeMatch) return { type: "police", style: policeMatch[1].toLowerCase(), text: policeMatch[2] };

  const traduisMatch = trimmed.match(/^traduis\s+(?:en\s+)?(\S+)\s+(.+)$/is);
  if (traduisMatch) return { type: "traduis", langue: traduisMatch[1], text: traduisMatch[2] };

  const majMatch = trimmed.match(/^majuscule\s+(.+)$/is);
  if (majMatch) return { type: "majuscule", text: majMatch[1] };

  const leetMatch = trimmed.match(/^leet\s+(.+)$/is);
  if (leetMatch) return { type: "leet", text: leetMatch[1] };

  const inverseMatch = trimmed.match(/^inverse\s+(.+)$/is);
  if (inverseMatch) return { type: "inverse", text: inverseMatch[1] };

  const meteoMatch = trimmed.match(/^(?:meteo|météo)\s+(.+)$/is);
  if (meteoMatch) return { type: "meteo", ville: meteoMatch[1].trim() };

  const fichierMatch = trimmed.match(/^fichier\s+(html|css|js)\s+(.+)$/is);
  if (fichierMatch) return { type: "fichier", lang: fichierMatch[1].toLowerCase(), description: fichierMatch[2].trim() };

  const zipMatch = trimmed.match(/^zip\s+(.+)$/is);
  if (zipMatch) return { type: "zip", description: zipMatch[1].trim() };

  const calculMatch = trimmed.match(/^calcul\s+(.+)$/is);
  if (calculMatch) return { type: "calcul", expr: calculMatch[1].trim() };

  const definitionMatch = trimmed.match(/^d[ée]finition\s+(.+)$/is);
  if (definitionMatch) return { type: "definition", mot: definitionMatch[1].trim() };

  const resumeMatch = trimmed.match(/^r[ée]sume\s+(.+)$/is);
  if (resumeMatch) return { type: "resume", text: resumeMatch[1] };

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
          "🧑‍💻 Mode Codeur activé — HTML, CSS, JS, bonnes pratiques et sécurité. Tape 'cours' pour apprendre, ou pose ta question de code. Écris 'mode normal' pour revenir."
        );
        break;

      case "mode_normal":
        userModes[senderId] = "normal";
        if (conversations[senderId]) conversations[senderId][0] = SYSTEM_PROMPTS.normal;
        await sendMessage(senderId, "💬 Retour au mode discussion classique.");
        break;

      case "cours_liste":
        await sendMessage(senderId, COURS_LISTE);
        break;

      case "cours": {
        const staticLesson = COURS_STATIC[command.topic];
        if (staticLesson) {
          await sendMessage(senderId, staticLesson);
          break;
        }
        const label = COURS_GENERES[command.topic] || command.topic;
        await sendTypingIndicator(senderId, "typing_on");
        const lesson = await callGroqWithFallback(
          [
            SYSTEM_PROMPTS.coder,
            {
              role: "user",
              content:
                "Donne un mini-cours pour débutant sur : " + label + ". Structure : 1) c'est quoi et à quoi ça sert, 2) les 5 notions clés, 3) un exemple de code court entouré de lignes contenant uniquement trois accents graves, 4) 3 bonnes pratiques. Texte simple, maximum 1800 caractères.",
            },
          ],
          0.5,
          2500
        );
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `📚 ${lesson}`);
        break;
      }

      case "dev": {
        await sendTypingIndicator(senderId, "typing_on");
        const answer = await callGroqWithFallback(
          [SYSTEM_PROMPTS.coder, { role: "user", content: command.question }],
          0.5,
          3000
        );
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `🧑‍💻 ${answer}`);
        break;
      }

      case "search": {
        await sendTypingIndicator(senderId, "typing_on");
        let result;
        try {
          result = await callGroqCompoundSearch(command.query);
          result = `🔎 ${result}`;
        } catch (err) {
          console.error("Recherche web indisponible, repli sur réponse générale:", err.message);
          const fallback = await callGroqWithFallback([
            { role: "system", content: "Réponds en français, de façon concise, à partir de tes connaissances générales." },
            { role: "user", content: command.query },
          ]);
          result = `⚠️ La recherche web en direct est momentanément indisponible, voici ce que je sais :\n\n${fallback}`;
        }
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, result);
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

      case "calcul": {
        try {
          const result = safeCalculate(command.expr);
          await sendMessage(senderId, `🧮 ${command.expr} = ${result}`);
        } catch (err) {
          await sendMessage(senderId, `Expression invalide 🤔 Exemple : calcul (2+3)*4`);
        }
        break;
      }

      case "definition": {
        await sendTypingIndicator(senderId, "typing_on");
        const def = await callGroqWithFallback([
          { role: "system", content: "Tu es un dictionnaire. Donne une définition claire et concise en français du mot donné, avec un exemple d'usage. Réponds uniquement avec la définition." },
          { role: "user", content: command.mot },
        ]);
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `📖 ${def}`);
        break;
      }

      case "resume": {
        await sendTypingIndicator(senderId, "typing_on");
        const summary = await callGroqWithFallback([
          { role: "system", content: "Résume le texte donné en 2-3 phrases maximum, en français, en gardant les informations essentielles." },
          { role: "user", content: command.text },
        ]);
        await sendTypingIndicator(senderId, "typing_off");
        await sendMessage(senderId, `✂️ ${summary}`);
        break;
      }

      case "fichier": {
        await sendTypingIndicator(senderId, "typing_on");
        try {
          const code = await generateSingleFileCode(command.lang, command.description);
          const mime = { html: "text/html", css: "text/css", js: "application/javascript" }[command.lang];
          await sendFileAttachment(senderId, `fichier.${command.lang}`, code, mime);
        } finally {
          await sendTypingIndicator(senderId, "typing_off");
        }
        break;
      }

      case "zip": {
        await sendTypingIndicator(senderId, "typing_on");
        try {
          const files = await generateMiniSite(command.description);
          const zipBuffer = await createZip({
            "index.html": files.html,
            "style.css": files.css,
            "script.js": files.js,
          });
          await sendFileAttachment(senderId, "projet.zip", zipBuffer, "application/zip");
        } finally {
          await sendTypingIndicator(senderId, "typing_off");
        }
        break;
      }
    }
  } catch (err) {
    console.error("Erreur handleCommand:", err.message);
    await sendMessage(senderId, "Désolé, une erreur est survenue avec cette commande 🙏");
  }
}

function stripMarkdownFences(text) {
  return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
}

async function generateSingleFileCode(language, description) {
  const prompts = {
    html: "Tu génères uniquement du code HTML valide et autonome (balises html/head/body incluses) pour la demande. Réponds uniquement avec le code, sans markdown, sans explication.",
    css: "Tu génères uniquement du code CSS pour la demande. Réponds uniquement avec le code, sans markdown, sans explication.",
    js: "Tu génères uniquement du code JavaScript pour la demande. Réponds uniquement avec le code, sans markdown, sans explication.",
  };
  const messages = [
    { role: "system", content: prompts[language] },
    { role: "user", content: description },
  ];
  const code = await callGroqWithFallback(messages, 0.7, 3000);
  return stripMarkdownFences(code);
}

async function generateMiniSite(description) {
  const messages = [
    {
      role: "system",
      content:
        "Tu génères un mini site web complet et cohérent (HTML + CSS + JS qui fonctionnent ensemble) pour la demande de l'utilisateur. Réponds EXACTEMENT sous cette forme, sans rien ajouter avant ni après, sans markdown :\n" +
        "===HTML===\n<code html ici>\n===CSS===\n<code css ici>\n===JS===\n<code js ici>",
    },
    { role: "user", content: description },
  ];
  const raw = await callGroqWithFallback(messages, 0.7, 4000);

  const htmlMatch = raw.match(/===HTML===([\s\S]*?)===CSS===/);
  const cssMatch = raw.match(/===CSS===([\s\S]*?)===JS===/);
  const jsMatch = raw.match(/===JS===([\s\S]*)$/);

  if (!htmlMatch || !cssMatch || !jsMatch) {
    throw new Error("Format de génération inattendu depuis Groq.");
  }

  return {
    html: stripMarkdownFences(htmlMatch[1]),
    css: stripMarkdownFences(cssMatch[1]),
    js: stripMarkdownFences(jsMatch[1]),
  };
}

async function createZip(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return await zip.generateAsync({ type: "nodebuffer" });
}

async function sendFileAttachment(recipientId, filename, content, mimeType) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const form = new FormData();
  form.append("recipient", JSON.stringify({ id: recipientId }));
  form.append("messaging_type", "RESPONSE");
  form.append("message", JSON.stringify({ attachment: { type: "file", payload: {} } }));
  const blob = new Blob([content], { type: mimeType });
  form.append("filedata", blob, filename);

  const res = await fetch(url, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) {
    console.error("Erreur sendFileAttachment:", JSON.stringify(data));
    throw new Error(`Envoi du fichier échoué: ${JSON.stringify(data)}`);
  }
  return data;
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

async function callGroqWithFallback(messages, temperature = 0.8, maxTokens = 1500) {
  let lastError;
  for (const model of GROQ_TEXT_MODELS) {
    try {
      return await callGroq(messages, model, temperature, maxTokens);
    } catch (err) {
      console.error(`Modèle texte ${model} indisponible:`, err.message);
      lastError = err;
    }
  }
  throw lastError;
}

async function callGroq(messages, model, temperature = 0.8, maxTokens = 1500) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
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
    const aiReply = await callGroqVisionWithFallback(
      imageUrl,
      systemPrompt,
      "Décris cette image et réponds de façon utile et chaleureuse."
    );

    history.push({ role: "user", content: "[a envoyé une photo]" });
    history.push({ role: "assistant", content: aiReply });
    conversations[senderId] = history;
    if (history.length > MAX_HISTORY + 1) conversations[senderId] = [history[0], ...history.slice(-MAX_HISTORY)];

    // On garde l'image en mémoire courte durée pour permettre une question de suivi.
    lastImageUrl[senderId] = imageUrl;

    await sendTypingIndicator(senderId, "typing_off");
    await sendMessage(senderId, aiReply);
  } catch (err) {
    console.error("Erreur handleImageMessage:", err.message);
    await sendMessage(senderId, "Désolé, je n'ai pas réussi à analyser cette photo 🙏");
  }
}

async function callGroqVisionWithFallback(imageUrl, systemPrompt, question) {
  let lastError;
  for (const model of GROQ_VISION_MODELS) {
    try {
      return await callGroqVision(imageUrl, systemPrompt, model, question);
    } catch (err) {
      console.error(`Modèle vision ${model} indisponible:`, err.message);
      lastError = err;
    }
  }
  throw lastError;
}

async function callGroqVision(imageUrl, systemPrompt, model, question) {
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
            { type: "text", text: question },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.8,
      max_tokens: 800,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Groq vision error (${model}): ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

function splitForMessenger(text) {
  if (text.length <= MESSENGER_TEXT_LIMIT) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > MESSENGER_TEXT_LIMIT) {
    let cut = remaining.lastIndexOf("\n", MESSENGER_TEXT_LIMIT);
    if (cut < MESSENGER_TEXT_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", MESSENGER_TEXT_LIMIT);
    }
    if (cut < MESSENGER_TEXT_LIMIT * 0.5) {
      cut = MESSENGER_TEXT_LIMIT;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendMessage(recipientId, text) {
  const chunks = splitForMessenger(text);
  let lastData;
  for (const chunk of chunks) {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PAGE_ID}/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { text: chunk } }),
    });
    const data = await res.json();
    if (!res.ok) console.error("Erreur sendMessage:", JSON.stringify(data));
    lastData = data;
  }
  return lastData;
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
