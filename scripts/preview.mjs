import http from 'node:http';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {default:worker}=await import(pathToFileURL(path.resolve('dist/server/index.js')).href);
const port=Number(process.env.PORT||8787);
const env={}; // Preview is deliberately credential-free. Use Wrangler for integration environments.
const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const origin=`http://127.0.0.1:${port}`;const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});const response=await worker.fetch(request,env,{waitUntil:p=>p.catch(()=>{})});res.writeHead(response.status,Object.fromEntries(response.headers.entries()));res.end(Buffer.from(await response.arrayBuffer()))}catch{res.writeHead(500);res.end('Falha na prévia.')}});
server.listen(port,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port} (demonstração sem credenciais)`));
