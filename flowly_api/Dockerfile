# Usa a imagem oficial do Node.js versão 18 como base
FROM node:22-slim

# Define o diretório de trabalho dentro do container como /app
# Todos os comandos subsequentes (como copiar arquivos ou instalar dependências)
# serão executados dentro desse diretório
WORKDIR /app

# Copia os arquivos de dependências do projeto para dentro do container
# O asterisco pega tanto package.json quanto package-lock.json (se existir)
COPY package*.json ./

# Instala as dependências do projeto via npm
RUN npm ci --omit=dev

# Copia todo o restante dos arquivos da aplicação para dentro do container
COPY . .

# Informa ao Docker que a aplicação será executada na porta 5000
# Isso é útil para documentação e para ferramentas como docker-compose
EXPOSE 5000

# Define o comando que será executado quando o container for iniciado
# Neste caso, inicia o servidor Node executando o arquivo server.js
CMD ["node", "server.js"]
