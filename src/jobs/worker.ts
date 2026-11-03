import { setTimeout as pause } from 'node:timers/promises';
import { claimJob } from './queue';
import { processJob } from './process';

let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
console.log('[worker] CounterShot durable worker online. Provider calls occur only for explicit jobs.');
while(!stopping){const job=claimJob();if(job){await processJob(job);}else await pause(750);}
console.log('[worker] Stopped.');
