FROM mhart/alpine-node:8.2

WORKDIR /root
ADD . /root

RUN npm install

ENTRYPOINT ["node", "index.js"]
