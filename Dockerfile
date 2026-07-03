# Use a lightweight Node.js 18 image as the base
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker's caching layer
COPY package*.json ./

# Install only production dependencies (skips devDependencies)
RUN npm install --production

# Copy the rest of your application files (agent.js, server.js, public folder, etc.)
COPY . .

# Expose the port your Express server listens on
EXPOSE 3000

# Command to start the application
CMD ["node", "server.js"]
