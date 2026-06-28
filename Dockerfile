FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
# Keep a seed copy of data/ for volume initialization on first run
RUN cp -r data data_seed
EXPOSE 3000
CMD ["sh", "-c", "if [ -z \"$(ls -A /app/data 2>/dev/null)\" ]; then echo 'First run: seeding data from data_seed...'; cp -r /app/data_seed/* /app/data/; fi && node server.js"]
