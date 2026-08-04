import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config();
export const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth:{persistSession:false,autoRefreshToken:false} });
export async function q<T=any>(fn:()=>any, label=''): Promise<T[]> {
  for(let a=1;a<=6;a++){
    try{ const {data,error}=await fn(); if(error){ console.log('  [',label,'] ERR',error.message); return []; } return (data??[]) as T[]; }
    catch(e:any){ if(a===6){console.log('  [',label,'] FETCH FAILED x6');return [];} await new Promise(r=>setTimeout(r,600*a)); }
  }
  return [];
}
export async function all<T=any>(table:string, cols='*', mod?:(b:any)=>any): Promise<T[]> {
  const PAGE=1000; const out:T[]=[];
  for(let from=0;;from+=PAGE){
    const page= await q<T>(()=>{ let b=sb.from(table).select(cols); if(mod) b=mod(b); return b.range(from,from+PAGE-1); }, table);
    out.push(...page);
    if(page.length<PAGE) break;
  }
  return out;
}
