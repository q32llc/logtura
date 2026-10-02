import type { DeploymentLink } from "./deployment-link";
export interface FlyTargetOptions {app?:string;region?:string;org?:string;}
export function linkedFlyTarget(link:DeploymentLink,options:FlyTargetOptions):{appName:string;region:string;org?:string;existingOnly:true}{
 if(!link.target)throw new Error("Pull again from a service with deployment target identity before deploying a linked configuration");
 if(link.target.kind!=="fly")throw new Error("Linked deployment does not target Fly");
 if(link.target.managed)throw new Error("Managed forwarders must be updated through the service deployment path");
 const bound=link.target.fly;
 if(bound && ((options.app!==undefined && options.app!==bound.appName) || (options.region!==undefined && bound.region!==undefined && options.region!==bound.region) || (options.org!==undefined && bound.orgSlug!==undefined && options.org!==bound.orgSlug)))throw new Error("Fly options conflict with the linked deployment target");
 const appName=bound?.appName??options.app;
 if(!appName || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appName))throw new Error("Unresolved legacy Fly target requires --app with the existing app name");
 const region=options.region??bound?.region??"iad",org=options.org??bound?.orgSlug;
 if(!/^[a-z]{3}$/.test(region) || (org!==undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(org)))throw new Error("Invalid Fly target options");
 return {appName,region,...(org!==undefined?{org}:{}),existingOnly:true};
}
