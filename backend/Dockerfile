# backend/Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copier package.json et package-lock (si présent) pour tirer avantage du cache
COPY package*.json ./

# Installer dépendances en mode production
RUN npm install --production

# Copier le reste
COPY . .

ENV PORT=5000
EXPOSE 5000

# Lancer le serveur
CMD ["node", "server.js"]
