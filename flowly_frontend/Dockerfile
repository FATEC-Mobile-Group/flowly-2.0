FROM node:22-slim AS build

WORKDIR /app

ARG VITE_API_URL
ARG VITE_API_PUBLIC_URL
ARG VITE_SOCKET_URL
ARG VITE_ASSISTANT_URL

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_PUBLIC_URL=$VITE_API_PUBLIC_URL
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL
ENV VITE_ASSISTANT_URL=$VITE_ASSISTANT_URL

RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL precisa ser informado no build" && exit 1)
RUN test -n "$VITE_API_PUBLIC_URL" || (echo "VITE_API_PUBLIC_URL precisa ser informado no build" && exit 1)
RUN test -n "$VITE_SOCKET_URL" || (echo "VITE_SOCKET_URL precisa ser informado no build" && exit 1)
RUN test -n "$VITE_ASSISTANT_URL" || (echo "VITE_ASSISTANT_URL precisa ser informado no build" && exit 1)

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM nginx:stable-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
