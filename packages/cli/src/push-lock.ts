import { dirname,resolve } from "node:path";
import { withPrivateDirectoryLock } from "./private-lock";
export function pushLockPath(config:string):string{return resolve(dirname(resolve(config)),".logtura-push.lock");}
export function withPushLock<T>(config:string,run:()=>Promise<T>):Promise<T>{
 return withPrivateDirectoryLock(pushLockPath(config),run);
}
