# Adéfal Messenger Bot — version Netlify

Chatbot Messenger pour page Facebook, propulsé par Groq (Llama 3.3 70B),
avec mémoire de conversation persistante via Netlify Blobs (gratuit, inclus).

## Déploiement

1. Crée un dépôt GitHub avec ces fichiers (garde la structure de dossiers,
   surtout `netlify/functions/webhook.js`).
2. Sur app.netlify.com → "Add new site" → "Import an existing project" →
   connecte ton repo GitHub.
3. Build settings : laisse vide (pas de build command nécessaire), Netlify
   détecte automatiquement les fonctions via `netlify.toml`.
4. Va dans "Site configuration" → "Environment variables" → ajoute :
   - `VERIFY_TOKEN` → une chaîne secrète que tu inventes (ex: `adefal_secret_123`)
   - `PAGE_ACCESS_TOKEN` → le token de ta Page Facebook
   - `GROQ_API_KEY` → ta clé sur console.groq.com
5. Déploie. Netlify te donne une URL type `https://ton-site.netlify.app`.
6. Ton URL de webhook sera : `https://ton-site.netlify.app/webhook`
   (grâce à la redirection configurée dans netlify.toml)

## Configurer le webhook dans Meta

1. App Meta → Messenger → Paramètres de Messenger API
2. Section "Configurez les webhooks" :
   - URL de rappel : `https://ton-site.netlify.app/webhook`
   - Vérifier le token : la même valeur que `VERIFY_TOKEN`
3. Coche `messages` et `messaging_postbacks`
4. Abonne ta Page

## Tester

Écris un message à ta Page depuis Messenger. Regarde les logs dans
Netlify → "Functions" → "webhook" → "Function log" si ça ne répond pas.

## Notes importantes

- **Mémoire** : chaque utilisateur a son historique stocké dans Netlify Blobs
  (namespace "conversations"), donc la conversation persiste même si la
  fonction redémarre entre deux messages.
- **Timeout** : les fonctions Netlify gratuites ont une limite d'exécution
  de 10 secondes. Si Groq répond lentement, ça peut occasionnellement
  timeout — normalement suffisant pour un usage normal.
- Tant que l'app Meta est en mode "Développement", seuls les rôles
  admin/testeur peuvent parler au bot. Il faut l'App Review (`pages_messaging`)
  pour ouvrir au public.
