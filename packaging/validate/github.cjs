'use strict';
// gh speaks only to this loopback HTTP fixture, never to GitHub or a real account.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
async function start(dir, env) {
  const requests = [];
  const server = http.createServer((req,res) => {
    requests.push(req.url);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:{viewer:{login:'validator',pullRequests:{nodes:[]},repositories:{nodes:[]},contributionsCollection:{contributionCalendar:{totalContributions:17,weeks:[]}}},search:{nodes:[]}}}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const bin = path.join(dir,'fake-bin'); fs.mkdirSync(bin,{mode:0o700});
  fs.writeFileSync(path.join(bin,'gh'),`#!/usr/bin/python3\nimport sys, urllib.request\nassert sys.argv[1:4] == ['api', 'graphql', '-f']\nassert 'mutation' not in sys.argv[4]\nprint(urllib.request.urlopen('http://127.0.0.1:${server.address().port}/graphql',timeout=3).read().decode())\n`,{mode:0o700});
  env.PATH = bin + ':' + env.PATH;
  return {requests, close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports = { start };
