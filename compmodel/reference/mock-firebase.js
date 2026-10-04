// 模擬 Firebase compat API（含權限規則），用 localStorage 在多個分頁之間共享資料
(function(){
  const KEY='__fs', ADMIN='admin@test.com', USERS={'admin@test.com':'pw123'};
  const load=()=>JSON.parse(localStorage.getItem(KEY)||'{}');
  let S=load();
  const listeners=new Set();
  const notify=()=>listeners.forEach(l=>setTimeout(()=>l.fire(),0));
  window.addEventListener('storage',e=>{ if(e.key===KEY){ S=load(); notify(); } });
  const save=()=>{ localStorage.setItem(KEY,JSON.stringify(S)); notify(); };
  let user=null; const authCbs=[];
  const isAdmin=()=>user&&user.email===ADMIN;
  const isSuper=()=>user&&user.email===ADMIN;
  const compOf=cid=>S['comps/'+cid];
  const isCompAdmin=cid=>!!user&&(isSuper()||(compOf(cid)&&compOf(cid).ownerId===user.uid)||(('compAdmins/'+cid+'_'+user.uid) in S));
  function canWrite(p,data,del){
    const seg=p.split('/');
    if(seg[0]==='comps'){
      const cid=seg[1];
      if(seg.length===2){
        if(!(p in S)) return isSuper()||(!!user&&data&&data.ownerId===user.uid);
        if(del) return isCompAdmin(cid);
        return isCompAdmin(cid)&&((data.ownerId??null)===(S[p].ownerId??null));
      }
      if(seg[2]==='entries'&&seg.length===4){
        if(isCompAdmin(cid)) return true;
        if(!user||seg[3]!==user.uid) return false;
        if(del||!(p in S)) return true;
        return (compOf(cid).selfScoring!==false) || JSON.stringify(data.results||{})===JSON.stringify(S[p].results||{});
      }
      return isCompAdmin(cid);
    }
    if(seg[0]==='compKeys'){ const cid=seg[1]; if(!(p in S)) return isSuper()||(!!user&&compOf(cid)&&compOf(cid).ownerId===user.uid); return isCompAdmin(cid); }
    if(seg[0]==='compAdmins'){ if(del) return isSuper(); return !!user&&p.split('/')[1]===data.compId+'_'+user.uid&&data.uid===user.uid&&S['compKeys/'+data.compId]&&data.key===S['compKeys/'+data.compId].key; }
    return false;
  }
  function canRead(p){
    const seg=p.split('/');
    if(seg[0]==='compKeys') return isCompAdmin(seg[1]);
    if(seg[0]==='compAdmins') return !!user&&seg[1].endsWith('_'+user.uid);
    return true;
  }
  const deny=()=>Promise.reject({code:'permission-denied',message:'Missing or insufficient permissions.'});
  const docSnap=p=>({id:p.split('/').pop(), exists:p in S, data:()=>S[p]?JSON.parse(JSON.stringify(S[p])):undefined});
  const collSnap=c=>{ const docs=Object.keys(S).filter(k=>k.startsWith(c+'/')&&!k.slice(c.length+1).includes('/')).map(docSnap); return {docs,size:docs.length,empty:!docs.length}; };
  window.__writes=0;
  const fs={
    doc:p=>({
      set:d=>{ if(!canWrite(p,d,false)) return deny(); if(JSON.stringify(d).length>1048576) return Promise.reject({code:'invalid-argument'}); S[p]=JSON.parse(JSON.stringify(d)); window.__writes++; save(); return Promise.resolve(); },
      delete:()=>{ if(!canWrite(p,null,true)) return deny(); delete S[p]; save(); return Promise.resolve(); },
      get:()=>canRead(p)?Promise.resolve(docSnap(p)):deny(),
      onSnapshot:(next,err)=>{ const l={fire:()=>{ if(canRead(p)) next(docSnap(p)); else err&&err({code:'permission-denied'}); }}; listeners.add(l); setTimeout(()=>l.fire(),0); return ()=>listeners.delete(l); }
    }),
    collection:c=>({
      get:()=>Promise.resolve(collSnap(c)),
      onSnapshot:(next,err)=>{ const l={fire:()=>next(collSnap(c))}; listeners.add(l); setTimeout(()=>l.fire(),0); return ()=>listeners.delete(l); }
    })
  };
  const setUser=u=>{ user=u; auth.currentUser=u; authCbs.forEach(cb=>setTimeout(()=>cb(u),0)); };
  const auth={
    currentUser:null,
    onAuthStateChanged:cb=>{ authCbs.push(cb); setTimeout(()=>cb(user),0); },
    signInAnonymously:()=>{ let id=sessionStorage.getItem('__anon'); if(!id){ id='anon'+Math.random().toString(36).slice(2,8); sessionStorage.setItem('__anon',id);} setUser({uid:id,isAnonymous:true,email:null}); return Promise.resolve(); },
    signInWithEmailAndPassword:(e,p)=>{ if(USERS[e]!==p) return Promise.reject({code:'auth/wrong-password'}); setUser({uid:'admin_uid',isAnonymous:false,email:e}); return Promise.resolve(); },
    signOut:()=>{ setUser(null); return Promise.resolve(); }
  };
  window.firebase={ initializeApp:()=>{}, auth:()=>auth, firestore:()=>fs };
})();
