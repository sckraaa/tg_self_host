# ---- Build stage ----
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apk add --no-cache bash && npm ci --ignore-scripts

COPY . .

# Build args injected from docker-compose (baked into the JS bundle at build time)
ARG TELEGRAM_API_ID
ARG TELEGRAM_API_HASH
ARG TELEGRAM_CUSTOM_SERVER
ARG TELEGRAM_CUSTOM_PORT=443
ARG TELEGRAM_CUSTOM_PROTOCOL=wss
ARG APP_NAME=pluma
ARG APP_TITLE=pluma
ARG APP_TME_LINK_PREFIX
ARG APP_HOSTNAME

ENV TELEGRAM_API_ID=$TELEGRAM_API_ID \
    TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
    TELEGRAM_CUSTOM_SERVER=$TELEGRAM_CUSTOM_SERVER \
    TELEGRAM_CUSTOM_PORT=$TELEGRAM_CUSTOM_PORT \
    TELEGRAM_CUSTOM_PROTOCOL=$TELEGRAM_CUSTOM_PROTOCOL \
    APP_NAME=$APP_NAME \
    APP_TITLE=$APP_TITLE \
    APP_TME_LINK_PREFIX=$APP_TME_LINK_PREFIX \
    APP_HOSTNAME=$APP_HOSTNAME \
    APP_FEEDBACK_URL="" \
    APP_FAQ_URL="" \
    APP_PRIVACY_URL="" \
    APP_MINI_APP_TOS_URL=""

RUN npm run build:production

# ---- Runtime stage (nginx) ----
FROM nginx:stable-alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
