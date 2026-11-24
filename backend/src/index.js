
import http from "http"
import { app } from "./app.js"
import { PORT } from "./config/config.js"
import DBConnect from "./db/db.js"
import { attachSocketServer } from "./websocket/socket-server.js"

const port=PORT||3000
const server=http.createServer(app)
attachSocketServer(server)

server.on("error",(error)=>{
    console.log("Server failed to start",error?.message);
    process.exit(1);
})

DBConnect()
.then(()=>{
    server.listen(port,()=>{
        console.log(`Server is running on the port ${port}`);
    })
})
.catch((error)=>{
    console.log("Not able to connect to DB",error);
})
