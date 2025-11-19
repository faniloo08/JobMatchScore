# Utilise une image Node.js officielle comme base
FROM node:18-alpine

# Définit le répertoire de travail dans le conteneur
WORKDIR /app

# Copie les fichiers package.json
COPY package*.json ./

# Installe les dépendances
RUN npm install --production

# Copie le reste des fichiers de l'application
COPY . .

# Expose le port 5000
EXPOSE 5000

# Commande pour démarrer l'application
CMD ["node", "server.js"]
