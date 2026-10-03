import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function normalizePackage(manifest){
 // Conditional export key order is semantic; only dependency maps are unordered.
 const result={...manifest};
 for(const key of ['dependencies','optionalDependencies','peerDependencies','devDependencies'])if(result[key])result[key]=Object.fromEntries(Object.entries(result[key]).sort(([a],[b])=>a.localeCompare(b)));
 return result;
}
export async function normalizePackedArchives(archives,temporary,artifacts,run){
 for(const [index,archive] of archives.entries()){
  const unpacked=join(temporary,`normalize-${index}`);mkdirSync(unpacked);
  // Archives were just produced from this checkout, before any external install.
  await run('tar',['-xzf',archive,'-C',unpacked]);
  const directory=join(unpacked,'package'),file=join(directory,'package.json');
  writeFileSync(file,JSON.stringify(normalizePackage(JSON.parse(readFileSync(file,'utf8'))),null,2)+'\n');
  await run('npm',['pack','--ignore-scripts','--pack-destination',artifacts],directory);
 }
}
