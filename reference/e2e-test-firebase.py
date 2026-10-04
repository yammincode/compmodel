import subprocess, time, json
from playwright.sync_api import sync_playwright
srv=subprocess.Popen(['python3','-m','http.server','8765'],cwd='/home/claude/test',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
MOCK=open('/home/claude/test/mock-firebase.js').read()
res=[]
def check(n,c,x=''): res.append(c); print(('✅' if c else '❌'),n,x)
alerts=[]
def setup(ctx,answers):
    page=ctx.new_page(); errs=[]
    page.on('pageerror',lambda e:errs.append(str(e)))
    page.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    def dlg(d):
        if d.type=='prompt': d.accept(answers.pop(0) if answers else '')
        else:
            if d.type=='alert': alerts.append(d.message)
            d.accept()
    page.on('dialog',dlg)
    def route(r):
        u=r.request.url
        if 'firebase-app-compat' in u: r.fulfill(body=MOCK,content_type='text/javascript')
        elif 'gstatic.com/firebasejs' in u: r.fulfill(body='',content_type='text/javascript')
        elif 'fonts.g' in u: r.abort()
        else: r.continue_()
    page.route('**/*',route)
    page.goto('http://localhost:8765/index.html'); page.wait_for_timeout(700)
    return page,errs
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844},accept_downloads=True)
    # 系統管理員匯入舊資料
    S,eS=setup(ctx,['admin@test.com','pw123'])
    S.click('#loginBtn'); S.wait_for_timeout(500)
    S.set_input_files('#importInput','data.json'); S.wait_for_timeout(1500)
    check('系統管理員匯入舊資料', '原岩模擬賽' in S.inner_text('#compList'))
    # A：一般人（匿名）建立比賽
    A,eA=setup(ctx,[])
    check('一般人看得到「建立新比賽」', A.is_visible('#newCompBtn'))
    check('一般人看不到匯入匯出', not A.is_visible('#importBtn'))
    A.click('#newCompBtn'); A.fill('#sTitle','小明的練習賽'); A.click('#startComp'); A.wait_for_timeout(1000)
    key=[m for m in alerts if '管理碼' in m]
    k=key[-1].split('管理碼：')[1].split('\n')[0] if key else ''
    check('一般人建立比賽成功並拿到管理碼', A.is_visible('#compView') and len(k)==6, k)
    check('主辦看到計時控制', A.is_visible('#tToggle'))
    check('主辦看到管理碼', k in A.inner_text('#keyLine'))
    check('主辦不會看到報名表', not A.is_visible('#joinCard'))
    A.click('#tToggle'); A.wait_for_timeout(1200)
    check('主辦開始計時', '暫停' in A.inner_text('#tToggle'))
    # B：選手加入
    B,eB=setup(ctx,[])
    B.click('.comp-item:has-text("小明的練習賽")'); B.wait_for_timeout(600)
    check('別人進比賽看到報名表', B.is_visible('#joinCard'))
    check('選手不能控制計時', not B.is_visible('#tToggle'))
    check('選手看不到管理碼', not B.is_visible('#keyLine'))
    c1=B.inner_text('#tClock'); B.wait_for_timeout(2100); c2=B.inner_text('#tClock')
    check('選手計時同步', c1!=c2, f'{c1}→{c2}')
    B.fill('#joinName','阿華'); B.click('#joinBtn'); B.wait_for_timeout(600)
    check('選手報名成功', B.is_visible('#nowCard'))
    B.click('.act.z'); B.click('.act.t'); B.wait_for_timeout(600)
    check('選手自己記分 (第2次Top=24.9)', B.inner_text('#nowScore')=='24.9', B.inner_text('#nowScore'))
    A.wait_for_timeout(300)
    check('主辦即時看到成績', '阿華' in A.inner_text('#board') and '24.9' in A.inner_text('#board'))
    # 權限
    r=B.evaluate("DB.doc('comps/'+compId).set({...M.comp,timer:{round:9,running:false,elapsed:0,startedAt:0}}).then(()=>'ok').catch(e=>e.code)")
    check('選手不能改計時', r!='ok', r)
    r=B.evaluate("DB.doc('compKeys/'+compId).get().then(()=>'ok').catch(e=>e.code)")
    check('選手讀不到管理碼', r!='ok', r)
    r=B.evaluate("DB.doc('comps/'+compId+'/entries/someone').set({name:'x'}).then(()=>'ok').catch(e=>e.code)")
    check('選手不能改別人成績', r!='ok', r)
    A.click('#selfToggle'); A.wait_for_timeout(500)
    r=B.evaluate("DB.doc('comps/'+compId+'/entries/'+myId).set({...M.entries[myId],results:{}}).then(()=>'ok').catch(e=>e.code)")
    check('關閉自行記分後，選手繞過畫面也改不了', r!='ok', r)
    check('關閉後按鈕鎖住', B.is_visible('#lockMsg'))
    A.click('#selfToggle'); A.wait_for_timeout(300)
    # 選手不能動舊比賽
    r=B.evaluate("Promise.resolve(Object.keys(comps).find(k=>comps[k].title==='原岩模擬賽')).then(id=>DB.doc('comps/'+id).delete()).then(()=>'ok').catch(e=>e.code)")
    check('選手不能刪別人的比賽', r!='ok', r)
    # C：用管理碼成為協同主辦
    C,eC=setup(ctx,['WRONG1', k])
    C.click('.comp-item:has-text("小明的練習賽")'); C.wait_for_timeout(500)
    check('別人進來先是一般身分', not C.is_visible('#tToggle') and C.is_visible('#claimLine'))
    C.click('#claimBtn'); C.wait_for_timeout(500)
    check('輸入錯的管理碼被拒', not C.is_visible('#tToggle'))
    C.click('#claimBtn'); C.wait_for_timeout(700)
    check('輸入正確管理碼變成主辦，可以計時', C.is_visible('#tToggle'))
    C.click('#tToggle'); C.wait_for_timeout(600)
    check('協同主辦暫停，大家同步', '開始' in A.inner_text('#tToggle') or '繼續' in A.inner_text('#tToggle'), A.inner_text('#tToggle'))
    # 主辦刪除選手 / 系統管理員管所有
    A.click('.row:has-text("阿華")'); A.wait_for_timeout(300)
    check('主辦可以幫選手改', A.is_visible('#nowCard') and '阿華' in A.inner_text('#nowName'))
    S.click('.comp-item:has-text("小明的練習賽")'); S.wait_for_timeout(500)
    check('系統管理員可以管理別人建的比賽', S.is_visible('#tToggle'))
    S.click('#backBtn'); S.wait_for_timeout(300)
    with S.expect_download() as dl: S.click('#exportBtn')
    exp=json.load(open(dl.value.path()))
    check('匯出含所有比賽與選手報名', any('/entries/' in k2 for k2 in exp['docs']) and sum(1 for k2 in exp['docs'] if k2.count('/')==1 and k2.startswith('comps/'))==2, f"{len(exp['docs'])} 筆")
    A.screenshot(path='host.png'); B.screenshot(path='player2.png')
    errs=[e for e in eS+eA+eB+eC if 'fonts' not in e and 'net::' not in e]
    check('沒有程式錯誤', not errs, '; '.join(errs[:4]))
    b.close()
srv.terminate()
print('\n通過', sum(res),'/',len(res))
