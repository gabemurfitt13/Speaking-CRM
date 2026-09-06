(function(root){
  'use strict';
  const fields={status:'status',notes:'notes',contact:'contact',phone:'phone',email:'email',principal:'principal',pPhone:'p_phone',sca:'sca',scaPhone:'sca_phone',followUp:'follow_up',contacted:'contacted',log:'log',spokenBefore:'spoken_before',fee:'fee',expenses:'expenses',students:'students',payStatus:'pay_status',gigDate:'gig_date'};
  function restore(seeds,rows,pending){
    const map=new Map(seeds.map(s=>[String(s.id),{...s}]));
    for(const row of rows){
      const id=String(row.school_id);
      const c={...(map.get(id)||{id,school:'Recovered school',status:'Not Started'})};
      for(const [key,column] of Object.entries(fields))if(row[column]!==null&&row[column]!==undefined)c[key]=row[column];
      if(row.record&&typeof row.record==='object')Object.assign(c,row.record);
      c.id=id; map.set(id,c);
    }
    for(const c of Object.values(pending||{}))map.set(String(c.id),c);
    return [...map.values()];
  }
  function rowFor(c,uid){
    const row={school_id:c.id,user_id:uid,record:c};
    for(const [key,column] of Object.entries(fields))row[column]=c[key]??(key==='log'?[]:key==='spokenBefore'?false:'');
    return row;
  }
  function create(client,storage,uid,seeds,notify){
    const key='gabe-crm-v4:'+uid;
    let pending={},baseline=new Map(),busy=null;
    function stash(){storage.setItem(key,JSON.stringify({pending}));}
    async function load(){
      const cached=storage.getItem(key);
      if(cached)pending=JSON.parse(cached).pending||{};
      let rows=[],from=0;
      while(true){
        const result=await client.from('progress').select('*').eq('user_id',uid).order('school_id').range(from,from+999);
        if(result.error)throw result.error;
        rows.push(...result.data);
        if(result.data.length<1000)break;
        from+=1000;
      }
      const contacts=restore(seeds,rows,pending);
      baseline=new Map(contacts.map(c=>[String(c.id),JSON.stringify(c)]));
      notify(Object.keys(pending).length?'Changes waiting to sync':'Cloud data loaded');
      return contacts;
    }
    function save(contacts){
      const next={...pending};
      for(const c of contacts)if(baseline.get(String(c.id))!==JSON.stringify(c))next[String(c.id)]=c;
      pending=next;
      try{stash();}catch(e){notify('Local backup failed. Keep this tab open and export a backup.');throw e;}
      baseline=new Map(contacts.map(c=>[String(c.id),JSON.stringify(c)]));
      if(Object.keys(pending).length)notify('Saved on this device; cloud sync pending');
    }
    function flush(){
      if(busy)return busy;
      if(!Object.keys(pending).length){notify('Saved to cloud');return Promise.resolve(true);}
      busy=(async()=>{
        try{
          const snapshot=Object.values(pending);
          for(let i=0;i<snapshot.length;i+=100){
            const batch=snapshot.slice(i,i+100);
            const result=await client.from('progress').upsert(batch.map(c=>rowFor(c,uid)),{onConflict:'school_id,user_id'});
            if(result.error)throw result.error;
            for(const c of batch)if(JSON.stringify(pending[String(c.id)])===JSON.stringify(c))delete pending[String(c.id)];
            stash();
          }
          notify(Object.keys(pending).length?'New changes waiting to sync':'Saved to cloud');
          return Object.keys(pending).length===0;
        }catch(e){notify('Cloud save failed. Changes retained on this device. Retry or export a backup.');console.error('CRM sync failed:',e.message);return false;}
        finally{busy=null;}
      })();
      return busy;
    }
    return {load,save,flush,hasPending:()=>Object.keys(pending).length>0};
  }
  const api={restore,rowFor,create};
  if(typeof module!=='undefined')module.exports=api;
  root.CRMPersistence=api;
})(typeof window==='undefined'?globalThis:window);
