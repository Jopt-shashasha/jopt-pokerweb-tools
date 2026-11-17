import { HTTPException } from 'hono/http-exception';
import { Store } from './db.js';
import { eventChoice } from './discovery.js';

export type EventAssignment={event:string;event_scope_id:string|null};
export function resourceEvents(store:Store,id:string):EventAssignment[]{
 return store.all<EventAssignment>('SELECT event,event_scope_id FROM resource_events WHERE resource_id=? ORDER BY event',id);
}
export function validateEvents(store:Store,values:{event:string;event_scope_id?:string|null}[]):EventAssignment[]{
 const result=values.map(value=>{const choice=eventChoice(store,value.event,value.event_scope_id??null);if(!choice.event)throw new HTTPException(400,{message:'大会を指定してください。'});return {event:choice.event,event_scope_id:choice.scope};});
 if(new Set(result.map(x=>x.event)).size!==result.length)throw new HTTPException(400,{message:'同じ大会は1回だけ選択してください。'});
 return result;
}
export function saveEvents(store:Store,id:string,values:EventAssignment[]){
 store.run('DELETE FROM resource_events WHERE resource_id=?',id);
 for(const value of values)store.run('INSERT INTO resource_events(resource_id,event,event_scope_id) VALUES (?,?,?)',id,value.event,value.event_scope_id);
}
