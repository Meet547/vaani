import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const directory of ['src','scripts','tests','public']){
  const entries=await readdir(directory,{withFileTypes:true});
  for(const entry of entries){if(!entry.isFile()||!/[.]m?js$/.test(entry.name))continue;const result=spawnSync(process.execPath,['--check',`${directory}/${entry.name}`],{stdio:'inherit'});if(result.status)process.exit(result.status);}
}
console.log('JavaScript syntax checks passed.');
