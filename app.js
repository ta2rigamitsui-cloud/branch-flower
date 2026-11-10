import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const cfg=window.BRANCH_CONFIG||{};
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const configured=/^https:\/\/.+\.supabase\.co\/?$/.test(cfg.url||'') && cfg.key && !cfg.key.startsWith('PASTE_');
let client=null,session=null,staff=null,db={products:[],deliveries:[],checks:[],adjustments:[]},page='home',current=null,homeFilter='active',busy=false,navStack=[],formDirty=false,analysisPeriod='week',analysisFrom='',analysisTo='',authView='login',recoverySession=false;
function showError(e){alert(e?.message||String(e))}
function header(title='BRANCH FLOWER',sub='生協｜鮮度・納品管理'){return `<nav class="top-nav" aria-label="ページ移動"><button type="button" data-page="home" class="top-nav-btn ${page==='home'?'active':''}">ホーム</button><button type="button" data-page="analysis" class="top-nav-btn ${page==='analysis'?'active':''}">分析</button><button type="button" data-page="history" class="top-nav-btn ${page==='history'?'active':''}">履歴</button></nav>${page!=='home'?'<button type="button" class="back-button" id="page-back">← 戻る</button>':''}<div class="header"><div><div class="brand">✿ ${esc(title)}</div><div class="muted">${esc(sub)}</div></div><button class="smallbtn" id="logout">ログアウト</button></div>`}
function timeline(id){return [...db.deliveries.filter(x=>x.product_id===id).map(x=>({type:'delivery',at:x.delivered_at,qty:x.quantity,id:x.id})),...db.checks.filter(x=>x.product_id===id).map(x=>({type:'check',at:x.checked_at,physical:x.physical_quantity,removed:x.removed_quantity,quality:x.freshness,id:x.id,note:x.note})),...db.adjustments.filter(x=>x.product_id===id).map(x=>({type:'adjustment',at:x.adjusted_at,qty:x.quantity_delta,id:x.id,reason:x.reason}))].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id))}
function state(id){let stock=0,sold=0,removed=0,unexplained=0,last=null,oldest=null;for(const e of timeline(id)){if(e.type==='delivery'){stock+=e.qty;if(!oldest)oldest=e.at;}else if(e.type==='adjustment'){stock+=e.qty;if(e.reason?.startsWith('回収:'))removed+=-e.qty;}else {const diff=stock-e.physical;if(diff>=0)sold+=diff;else unexplained+=-diff;removed+=e.removed;stock=e.physical-e.removed;last=e;}}return {stock,sold,removed,unexplained,last,oldest}}
// 納品日別の残数はFIFO（古い納品分から販売・回収）による推定値。
// 現物だけでは納品ロットを識別できないため、確定在庫として扱わない。
function estimatedLots(id){
  const lots=[];
  function consume(n){
    for(const lot of lots){
      if(n<=0)break;
      const used=Math.min(n,lot.remaining);
      lot.remaining-=used;n-=used;
    }
  }
  for(const e of timeline(id)){
    if(e.type==='delivery')lots.push({at:e.at,quantity:e.qty,remaining:e.qty,known:true});
    else if(e.type==='adjustment'){
      if(e.qty>0)lots.push({at:e.at,quantity:e.qty,remaining:e.qty,known:false});
      else consume(-e.qty);
    }else{
      const before=lots.reduce((sum,x)=>sum+x.remaining,0);
      if(before>e.physical)consume(before-e.physical);
      else if(before<e.physical)lots.push({at:e.at,quantity:e.physical-before,remaining:e.physical-before,known:false});
      consume(e.removed);
    }
  }
  return lots.filter(x=>x.remaining>0);
}
function lotAge(at){return Math.max(0,Math.floor((Date.now()-new Date(at).getTime())/86400000))}
function lotDate(at){return new Date(at).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'})}
function status(id){
  const s=state(id),lots=estimatedLots(id);
  const known=lots.filter(x=>x.known);
  const days=s.stock>0&&known.length?Math.max(...known.map(x=>lotAge(x.at))):null;
  let label='通常',cls='';
  if(days!==null&&days>=5){label='重点確認';cls='danger'}
  else if(days!==null&&days>=3){label='鮮度確認';cls='warn'}
  if(s.last?.quality==='unsellable'){label='販売不可';cls='danger'}
  else if(s.last?.quality==='watch'){label='要注意';cls='warn'}
  return {days,label,cls};
}
function selectCheck(){
  const cards=db.products.filter(p=>state(p.id).stock>0).map(p=>`<button type="button" class="select-product" data-detail="${p.id}"><span><strong>${esc(p.name)}</strong><small>${p.price_yen}円</small></span><span>記録上 ${state(p.id).stock}束 ›</span></button>`).join('');
  return header('売場確認・引き上げ','確認する商品だけ選択')+`<div class="card"><p class="note">確認した商品だけ更新します。未確認の商品は変更されません。</p>${cards||'<p class="note">在庫のある商品はありません。</p>'}</div><button class="button secondary" data-page="home">ホームへ戻る</button>`;
}
function home(){
  const activeProducts=db.products.filter(p=>state(p.id).stock>0);
  const total=activeProducts.reduce((sum,p)=>sum+state(p.id).stock,0);
  const alerts=activeProducts.filter(p=>status(p.id).cls).length;
  const visible=db.products.filter(p=>{
    const stock=state(p.id).stock;
    if(homeFilter==='zero')return stock===0;
    if(homeFilter==='all')return true;
    if(homeFilter==='alert')return stock>0&&!!status(p.id).cls;
    if(homeFilter==='normal')return stock>0&&!status(p.id).cls;
    return stock>0;
  });
  const pillStyle=cls=>cls==='danger'?'background:#FDE8E7;color:#A32F2A':cls==='warn'?'background:#FFF2CF;color:#845700':'background:#E4F3E9;color:#236447';
  const cards=visible.map(p=>{
    const s=state(p.id),st=status(p.id),lots=estimatedLots(p.id);
    const lotTotal=lots.reduce((a,x)=>a+x.remaining,0);
    const lotBar=lotTotal>0?`<div style="display:flex;height:12px;border-radius:999px;overflow:hidden;gap:2px;margin:9px 0">${lots.map(x=>{
      const age=x.known?lotAge(x.at):null;
      const color=age===null?'#98A2B3':age>=5?'#D96A61':age>=3?'#E8B454':'#69A88D';
      return `<span title="${x.known?lotDate(x.at):'日付不明'}：${x.remaining}束（推定）" style="flex:${x.remaining};background:${color}"></span>`;
    }).join('')}</div>`:'';
    const lotLegend=lots.length?lots.map(x=>{
      const age=x.known?lotAge(x.at):null;
      const color=age===null?'#98A2B3':age>=5?'#D96A61':age>=3?'#E8B454':'#69A88D';
      return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#667085"><span style="width:9px;height:9px;border-radius:3px;background:${color};display:inline-block"></span>${x.known?lotDate(x.at)+'納品':'日付不明'}：${x.remaining}束</span>`;
    }).join(''):'<span class="muted">推定残数なし</span>';
    return `<article class="card item" data-detail="${p.id}" style="border-radius:16px">
      <div class="row"><div><h3 style="margin:0 0 4px">${esc(p.name)}</h3><div class="muted">${p.price_yen}円</div></div><span class="pill" style="${pillStyle(st.cls)}">${st.label}</span></div>
      <div class="row" style="margin-top:14px;align-items:end"><div><div class="muted">記録上の在庫</div><div class="big" style="font-size:32px">${s.stock}<span style="font-size:14px"> 束</span></div></div><div class="right"><div class="muted">推定で残る最古の納品から</div><strong>${st.days===null?'—':st.days+'日'}</strong></div></div>
      <div style="margin-top:14px;padding:11px;text-align:center;border:1px solid #cbd5d1;border-radius:10px;color:#356b56;font-weight:700">商品を確認 ›</div>
    </article>`;
  }).join('');
  const filterButtons=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${[['active','販売中'],['zero','在庫ゼロ'],['all','すべて']].map(([value,label])=>`<button type="button" class="smallbtn" data-home-filter="${value}" aria-pressed="${homeFilter===value}" style="${homeFilter===value?'background:#356b56;color:white;border-color:#356b56':''}">${label}</button>`).join('')}</div>`;
  return header()+`<div class="card summary"><h3>在庫の状況</h3><div class="grid"><div><div class="big">${total}</div><div class="muted">在庫総数</div></div><div><div class="big">${activeProducts.length}</div><div class="muted">販売中商品</div></div><div><div class="big">${alerts}</div><div class="muted">要確認</div></div></div></div><div class="quick-actions"><button class="action-tile" data-page="check">✓<small>売場確認・引き上げ</small></button><button class="action-tile" data-page="delivery">＋<small>花を納品</small></button></div><h2>商品別の在庫</h2>${filterButtons}${cards||'<div class="card empty">該当する商品はありません</div>'}<p class="note">※鮮度警告は目安です。実際の花の状態を確認してください。</p>`;
}

function selectRemoval(){
 const cards=db.products.filter(p=>state(p.id).stock>0).map(p=>`<button type="button" class="select-product" data-detail="${p.id}"><span><strong>${esc(p.name)}</strong><small>${p.price_yen}円</small></span><span>記録上 ${state(p.id).stock}束 ›</span></button>`).join('');
 return header('引き上げ','商品を選択')+`<div class="card"><p class="note">現行の保存処理を安全に利用するため、引き上げ前の現物残数も入力します。回収数だけの独立登録は次の工程で対応します。</p>${cards||'<p class="note">在庫のある商品はありません。</p>'}</div><button class="button secondary" data-page="home">ホームへ戻る</button>`;
}
function todayJST(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}

function productOptions(){return db.products.filter(p=>p.active).map(p=>`<option value="${p.id}">${esc(p.name)}・${p.price_yen}円</option>`).join('')}
function deliveryRow(){return `<div class="delivery-line"><label>商品</label><select name="productId" required>${productOptions()}</select><label>納品数量（束）</label><input name="qty" type="number" min="1" max="999" value="5" required><button type="button" class="smallbtn remove-line">この行を削除</button></div>`}
function delivery(){return header('花を納品')+`<div class="card"><form id="batch-delivery-form"><p class="note">当日分の納品をまとめて登録します。日付と時刻は自動記録されます。</p><div id="delivery-lines">${deliveryRow()}</div><button type="button" id="add-line" class="button secondary">＋ 別の商品も納品</button><button class="button" style="margin-top:12px" ${db.products.some(p=>p.active)?'':'disabled'}>まとめて納品を保存</button></form></div><div class="card"><h3>新しい商品を登録</h3><p class="note">新商品は登録後、上の納品欄で選択してください。</p><form id="product-form"><label>商品名</label><input name="name" maxlength="80" required><label>価格（円）</label><input type="number" name="price" min="1" required><button class="button secondary" style="margin-top:12px">商品を追加</button></form></div>`}
function removalDetail(id){const p=db.products.find(p=>p.id===id);if(!p)return selectRemoval();const s=state(id);return header('花を引き上げる',`${p.name}｜${p.price_yen}円`)+`<div class="card"><strong>${esc(p.name)}</strong><p class="note">記録上の在庫：${s.stock}束</p><form id="removal-form" data-id="${id}" data-expected="${s.stock}"><label>引き上げた数量（束）</label><input type="number" name="qty" min="1" max="999" value="1" required><label>回収理由</label><select name="reason"><option value="鮮度低下">鮮度低下</option><option value="しおれ・傷み">しおれ・傷み</option><option value="その他">その他</option></select><label class="check-toggle"><input type="checkbox" name="withCount" id="with-count"> 引き上げ後の残数も確認する（任意）</label><div id="remaining-area" hidden><label>引き上げ後の実際の残数</label><input name="remaining" type="number" min="0" max="9999" placeholder="例：3"><p class="note">この場合は回収前の現物数＝引き上げ数＋残数として、販売数も推定します。</p></div><button class="button" style="margin-top:14px">引き上げを保存</button></form></div><button class="button secondary" data-page="removal">商品選択に戻る</button>`}

function detail(id){const p=db.products.find(p=>p.id===id);if(!p)return home();const s=state(id),st=status(id);return header(p.name,`${p.price_yen}円｜現物確認`)+`<div class="card"><div class="row"><strong>記録上の在庫 ${s.stock}束</strong><span class="pill ${st.cls}">${st.label}</span></div><p class="note">回収前の現物を数えてください。記録との差が売上と断定できるわけではありません。</p><form id="check-form" data-id="${id}" data-expected="${s.stock}"><label>今回の現物残数（回収前）</label><input name="count" type="number" min="0" max="9999" value="${Math.max(0,s.stock)}" required><label>鮮度判定</label><select name="quality"><option value="good">✓ 良好・継続販売</option><option value="watch">△ 要注意・経過観察</option><option value="unsellable">✕ 販売不可・回収判断</option></select><label>今回の回収数</label><input name="remove" type="number" min="0" value="0" required><label>回収理由</label><select name="reason"><option value="鮮度低下">鮮度低下</option><option value="しおれ・傷み">しおれ・傷み</option><option value="その他">その他</option></select><label>メモ（任意）</label><textarea name="note" rows="2" maxlength="500"></textarea><button class="button" style="margin-top:15px">確認内容を保存</button></form></div><button class="button secondary" data-page="home">商品一覧に戻る</button>`}
function jstDay(date){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)}
function analysisRange(){
  const today=todayJST(),base=new Date(today+'T12:00:00+09:00');
  if(analysisPeriod==='month')return {from:today.slice(0,7)+'-01',to:today};
  if(analysisPeriod==='custom')return {from:analysisFrom,to:analysisTo};
  const dow=(base.getDay()+6)%7;
  const start=new Date(base.getTime()-dow*86400000);
  return {from:jstDay(start),to:today};
}
function analysis(){
  const range=analysisRange(),valid=!!range.from&&!!range.to&&range.from<=range.to;
  const inRange=at=>valid&&jstDay(new Date(at))>=range.from&&jstDay(new Date(at))<=range.to;
  const rows=db.products.map(p=>{
    let stock=0,sold=0,removed=0,delivered=0,unexplained=0,opening=0,checked=0;
    const ev=timeline(p.id);
    for(const e of ev){
      const date=jstDay(new Date(e.at));
      if(valid&&date<range.from){
        if(e.type==='delivery')stock+=e.qty;
        else if(e.type==='adjustment')stock+=e.qty;
        else stock=e.physical-e.removed;
        continue;
      }
      if(valid&&date>range.to)break;
      if(e.type==='delivery'){stock+=e.qty;if(inRange(e.at))delivered+=e.qty;}
      else if(e.type==='adjustment'){
        stock+=e.qty;
        if(inRange(e.at)&&e.qty<0&&e.reason?.startsWith('回収:'))removed+=-e.qty;
      }else{
        const diff=stock-e.physical;
        if(inRange(e.at)){
          checked++;
          if(diff>=0)sold+=diff;else unexplained+=-diff;
          removed+=e.removed;
        }
        stock=e.physical-e.removed;
      }
    }
    // Calculate opening balance separately, including prior events only.
    let before=0;
    if(valid)for(const e of ev){if(jstDay(new Date(e.at))>=range.from)break;if(e.type==='delivery')before+=e.qty;else if(e.type==='adjustment')before+=e.qty;else before=e.physical-e.removed;}
    opening=before;
    const available=opening+delivered;
    return {p,sold,removed,delivered,unexplained,checked,opening,available,revenue:sold*p.price_yen,rate:available>0?Math.round(sold/available*100):null};
  });
  const sum=k=>rows.reduce((a,r)=>a+r[k],0);
  const options=[['week','今週'],['month','今月'],['custom','期間指定']].map(([v,l])=>`<button type="button" class="smallbtn ${analysisPeriod===v?'analysis-selected':''}" data-analysis-period="${v}">${l}</button>`).join('');
  const custom=analysisPeriod==='custom'?`<div class="analysis-dates"><label>開始日<input type="date" id="analysis-from" value="${esc(analysisFrom)}"></label><label>終了日<input type="date" id="analysis-to" value="${esc(analysisTo)}"></label></div>`:'';
  const yen=n=>Math.round(n).toLocaleString('ja-JP')+'円';
  const cards=valid?rows.filter(r=>r.delivered||r.sold||r.removed||r.checked).map(r=>`<div class="card"><div class="row"><strong>${esc(r.p.name)} <span class="muted">${r.p.price_yen}円</span></strong><strong>${r.sold}束</strong></div><div class="bar"><span style="width:${sum('sold')?Math.min(100,Math.round(r.sold/Math.max(1,...rows.map(x=>x.sold))*100)):0}%"></span></div><p class="note">推定売上 ${yen(r.revenue)} / 納品 ${r.delivered}束 / 回収 ${r.removed}束 / 参考販売率 ${r.rate===null?'—':r.rate+'%'}</p>${r.checked===0?'<p class="note">※この期間に売場確認なし</p>':''}</div>`).join(''):'';
  return header('売れ行き分析','確認日を基準に集計した推定値')+`<div class="card"><div class="analysis-periods">${options}</div>${custom}<p class="note">${valid?`${range.from} ～ ${range.to}`:'開始日と終了日を指定してください'}</p></div>`+(valid?`<div class="card summary"><div class="analysis-kpis"><div><div class="big">${sum('sold')}</div><div class="muted">推定販売束数</div></div><div><div class="big">${yen(sum('revenue'))}</div><div class="muted">推定売上</div></div><div><div class="big">${sum('removed')}</div><div class="muted">回収束数</div></div><div><div class="big">${sum('delivered')}</div><div class="muted">納品束数</div></div></div></div><h2>商品別の売れ行き</h2>${cards||'<div class="card empty">対象期間の記録はありません。</div>'}<p class="note">推定販売数は売場確認日にまとめて計上します。販売率は「推定販売数 ÷（期首の記録在庫＋期間内納品数）」の参考値です。未確認の販売、盗難、記録漏れ等が含まれる可能性があり、実際のレジ売上ではありません。過去の価格変更は現在の商品価格で計算されます。</p>`:'');
}
function history(){const all=[...db.deliveries.map(x=>({at:x.delivered_at,product_id:x.product_id,txt:`納品 ${x.quantity}束`,note:x.note})),...db.checks.map(x=>({at:x.checked_at,product_id:x.product_id,txt:`現物 ${x.physical_quantity}束・回収 ${x.removed_quantity}束・鮮度 ${x.freshness}`,note:x.note})),...db.adjustments.map(x=>({at:x.adjusted_at,product_id:x.product_id,txt:x.reason?.startsWith('回収:')?`回収 ${-x.quantity_delta}束`:`在庫調整 ${x.quantity_delta}束`,note:x.reason}))].sort((a,b)=>b.at.localeCompare(a.at));return header('作業履歴')+(all.length?all.slice(0,150).map(e=>`<div class="card"><div class="row"><strong>${esc(db.products.find(p=>p.id===e.product_id)?.name||'不明')}</strong><span class="muted">${new Date(e.at).toLocaleString('ja-JP')}</span></div><p>${esc(e.txt)}</p>${e.note?`<p class="note">${esc(e.note)}</p>`:''}</div>`).join(''):'<div class="card empty">履歴はまだありません。</div>')}
function login(){return `<div class="auth"><div class="brand">ブランチ｜花管理</div><p class="muted">生協｜スタッフログイン</p><div class="card"><form id="login-form"><label>メールアドレス</label><input type="email" name="email" autocomplete="username" required><label>パスワード</label><input type="password" name="password" autocomplete="current-password" required><button class="button" style="margin-top:18px">ログイン</button></form><button type="button" class="linkbutton auth-switch" data-auth-view="forgot">パスワードを忘れた方</button></div><p class="note">管理者がSupabaseで作成したスタッフアカウントを使用します。</p></div>`}
function forgotPassword(){return `<div class="auth"><div class="brand">ブランチ｜花管理</div><h2>パスワードの再設定</h2><div class="card"><p class="note">登録したメールアドレスに再設定用のリンクを送信します。</p><form id="forgot-form"><label>メールアドレス</label><input type="email" name="email" autocomplete="email" required><button class="button" style="margin-top:18px">再設定メールを送信</button></form><button type="button" class="linkbutton auth-switch" data-auth-view="login">ログインに戻る</button></div></div>`}
function newPassword(){return `<div class="auth"><div class="brand">ブランチ｜花管理</div><h2>新しいパスワードを設定</h2><div class="card"><form id="new-password-form"><label>新しいパスワード（12文字以上）</label><input type="password" name="password" minlength="12" autocomplete="new-password" required><label>新しいパスワード（確認）</label><input type="password" name="confirm" minlength="12" autocomplete="new-password" required><button class="button" style="margin-top:18px">パスワードを変更</button></form></div></div>`}
function render(){formDirty=false;$('#app').innerHTML=authView==='reset'?newPassword():authView==='forgot'?forgotPassword():!session?login():!staff?`<div class="card"><h3>利用許可がありません</h3><p>管理者にstaff_membersの登録を確認してもらってください。</p><button class="button" id="logout">ログアウト</button></div>`:page==='home'?home():page==='check'?selectCheck():page==='removal'?selectRemoval():page==='delivery'?delivery():page==='analysis'?analysis():page==='history'?history():page==='removalDetail'?removalDetail(current):detail(current);}
async function refresh(){const [p,d,c,a,m]=await Promise.all([client.from('products').select('*').order('name'),client.from('deliveries').select('*').order('delivered_at'),client.from('stock_checks').select('*').order('checked_at'),client.from('stock_adjustments').select('*').order('adjusted_at'),client.from('staff_members').select('role,active').eq('user_id',session.user.id).maybeSingle()]);for(const r of [p,d,c,a,m])if(r.error)throw r.error;staff=m.data?.active?m.data:null;db={products:p.data,deliveries:d.data,checks:c.data,adjustments:a.data};render();}
async function start(){
  if(!configured){$('#app').innerHTML='<div class="card"><h3>接続設定が必要です</h3><p>config.jsにSupabaseのProject URLとpublishable keyを設定してください。</p></div>';return;}
  client=createClient(cfg.url,cfg.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  // リカバリーイベントは初回セッション復元より前に監視する。
  client.auth.onAuthStateChange((event,nextSession)=>{
    session=nextSession;
    if(event==='PASSWORD_RECOVERY'){
      recoverySession=true;authView='reset';staff=null;render();return;
    }
    if(event==='SIGNED_OUT'){
      session=null;staff=null;recoverySession=false;authView='login';render();
    }
  });
  const {data,error}=await client.auth.getSession();
  if(error)showError(error);
  session=data?.session||null;
  if(authView==='reset'){render();}
  else if(session){try{await refresh()}catch(e){showError(e);render()}}
  else render();
  if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
function allowLeave(){return !formDirty||confirm('入力途中の内容は保存されません。画面を移動しますか？')}
function navigate(next,productId=null){if(next===page&&productId===null)return;if(!allowLeave())return;navStack.push({page,current});page=next;if(productId!==null)current=productId;render();window.scrollTo(0,0)}
function goBack(){if(!allowLeave())return;const prev=navStack.pop()||{page:'home',current:null};page=prev.page;current=prev.current;render();window.scrollTo(0,0)}
document.addEventListener('input',e=>{if(e.target.closest('#app form')&&e.target.closest('form').id!=='login-form')formDirty=true});
document.addEventListener('click',async e=>{const authButton=e.target.closest('[data-auth-view]');if(authButton){authView=authButton.dataset.authView;render();return;}const filterButton=e.target.closest('[data-home-filter]');if(filterButton){homeFilter=filterButton.dataset.homeFilter;render();return;}if(e.target.closest('#add-line')){const box=$('#delivery-lines');if(box.children.length<50)box.insertAdjacentHTML('beforeend',deliveryRow());return;}if(e.target.closest('.remove-line')){const rows=$('#delivery-lines');if(rows.children.length>1)e.target.closest('.delivery-line').remove();return;}if(e.target.closest('#page-back')){goBack();return;}if(e.target.closest('#logout')){if(!allowLeave())return;await client.auth.signOut();session=null;staff=null;navStack=[];render();return}const nav=e.target.closest('[data-page]');if(nav){navigate(nav.dataset.page);return}const detail=e.target.closest('[data-detail]');if(detail){navigate(page==='removal'?'removalDetail':'detail',detail.dataset.detail)}});
document.addEventListener('click',e=>{const b=e.target.closest('[data-analysis-period]');if(!b)return;analysisPeriod=b.dataset.analysisPeriod;if(analysisPeriod==='custom'&&!analysisFrom){analysisFrom=todayJST();analysisTo=todayJST();}render();});
document.addEventListener('change',e=>{if(e.target.id==='analysis-from'){analysisFrom=e.target.value;render();}if(e.target.id==='analysis-to'){analysisTo=e.target.value;render();}});
document.addEventListener('change',e=>{if(e.target.id==='with-count'){$('#remaining-area').hidden=!e.target.checked;formDirty=true;}});
document.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;const f=e.target,data=Object.fromEntries(new FormData(f));busy=true;const btn=f.querySelector('button[type=submit],button.button');if(btn)btn.disabled=true;try{
  if(f.id==='forgot-form'){
    const email=String(data.email||'').trim();
    const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo:'https://ta2rigamitsui-cloud.github.io/branch-flower/'});
    if(error)throw error;
    alert('登録状況にかかわらず、メールを送信できる場合は再設定の案内が届きます。受信箱・迷惑メールをご確認ください。');
    authView='login';render();return;
  }
  if(f.id==='new-password-form'){
    if(!recoverySession||!session)throw Error('再設定リンクの確認ができません。メールのリンクから開き直してください。');
    if(String(data.password||'').length<12)throw Error('パスワードは12文字以上にしてください。');
    if(data.password!==data.confirm)throw Error('確認用パスワードが一致しません。');
    const {error}=await client.auth.updateUser({password:data.password});
    if(error)throw error;
    recoverySession=false;authView='login';
    const {error:signOutError}=await client.auth.signOut();
    if(signOutError)throw signOutError;
    session=null;staff=null;render();alert('パスワードを変更しました。新しいパスワードでログインしてください。');return;
  }
  if(f.id==='login-form'){const {data:auth,error}=await client.auth.signInWithPassword({email:data.email,password:data.password});if(error)throw error;session=auth.session;await refresh();return;}if(f.id==='product-form'){const name=data.name.trim(),price=Number(data.price);if(!name||!Number.isInteger(price)||price<1)throw Error('商品名と価格を確認してください');const {error}=await client.from('products').insert({name,price_yen:price});if(error)throw error;page='delivery';await refresh();alert('商品を登録しました');return;}if(f.id==='batch-delivery-form'){const items=[...f.querySelectorAll('.delivery-line')].map(row=>({product_id:row.querySelector('[name="productId"]').value,quantity:Number(row.querySelector('[name="qty"]').value)}));if(!items.length||items.some(x=>!x.product_id||!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>999))throw Error('商品と数量を確認してください');const {error}=await client.rpc('save_deliveries_batch',{p_items:items});if(error)throw error;page='home';navStack=[];await refresh();alert(`${items.length}件の納品を登録しました`);return;}if(f.id==='removal-form'){const id=f.dataset.id,expected=Number(f.dataset.expected),qty=Number(data.qty),withCount=!!f.querySelector('[name="withCount"]').checked;if(!Number.isInteger(qty)||qty<1||qty>999)throw Error('回収数を確認してください');if(withCount){if(data.remaining===''||!Number.isInteger(Number(data.remaining))||Number(data.remaining)<0)throw Error('残数を入力してください');const physical=qty+Number(data.remaining);if(physical>expected&&!confirm('記録上の在庫より現物が多い状態です。差異として記録しますか？'))return;const {error}=await client.rpc('save_stock_check',{p_product_id:id,p_expected_stock:expected,p_physical_quantity:physical,p_freshness:'good',p_removed_quantity:qty,p_removal_reason:data.reason,p_note:null});if(error)throw error;}else{const {error}=await client.rpc('save_removal_only',{p_product_id:id,p_expected_stock:expected,p_quantity:qty,p_reason:data.reason});if(error)throw error;}page='home';navStack=[];await refresh();alert('引き上げを保存しました');return;}if(f.id==='delivery-form'){const qty=Number(data.qty);if(!Number.isInteger(qty)||qty<1||qty>999)throw Error('数量を確認してください');if(!/^\d{4}-\d{2}-\d{2}$/.test(data.deliveryDate||'')||data.deliveryDate>todayJST())throw Error('納品日を確認してください');const {error}=await client.rpc('save_delivery_dated',{p_product_id:data.productId,p_quantity:qty,p_note:data.note||null,p_delivery_date:data.deliveryDate});if(error)throw error;page='home';navStack=[];await refresh();alert('納品を登録しました');return;}if(f.id==='check-form'){const count=Number(data.count),remove=Number(data.remove),expected=Number(f.dataset.expected);if(!Number.isInteger(count)||!Number.isInteger(remove)||count<0||remove<0||remove>count)throw Error('現物残数・回収数を確認してください');if(count>expected&&!confirm('記録上の在庫より現物が多い状態です。未登録の納品がないか確認してください。差異として記録しますか？'))return;const {error}=await client.rpc('save_stock_check',{p_product_id:f.dataset.id,p_expected_stock:expected,p_physical_quantity:count,p_freshness:data.quality,p_removed_quantity:remove,p_removal_reason:remove?data.reason:null,p_note:data.note||null});if(error)throw error;page='home';navStack=[];await refresh();alert('鮮度・在庫確認を保存しました');return;}}catch(err){showError(err);if(session)try{await refresh()}catch{}}finally{busy=false;if(btn?.isConnected)btn.disabled=false}});
start();
