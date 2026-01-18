FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy application files
COPY src/ ./src/

# Expose WebSocket port
EXPOSE 2333

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "const ws=new(require('ws'))('ws://localhost:2333');ws.on('error',()=>process.exit(1));ws.on('open',()=>{ws.close();process.exit(0)})"

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Start the server
CMD ["node", "src/server.js"]
