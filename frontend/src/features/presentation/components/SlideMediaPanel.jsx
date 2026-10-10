import { useEffect, useRef, useState } from 'react';
import { presentationApi, errorMessage } from '../service';
import { Select, Textarea, Checkbox } from '../../../components/ui/Input';
import Button from '../../../components/ui/Button';
import './SlideMediaPanel.css';

const STATUS = {creating:'Đang gửi yêu cầu',queued:'Đang chờ tạo video',processing:'Đang tạo video',completed:'Sẵn sàng xem trước',failed:'Tạo thất bại'};
const PLACEMENT_LABEL={auto:'AI quyết định khi xuất',background:'Ảnh nền toàn slide',left:'Bên trái',right:'Bên phải',top:'Vùng phía trên',accent:'Điểm nhấn nhỏ'};
function MediaPreview({ presentationId, asset }) {
  const [url,setUrl] = useState(''); const [error,setError] = useState('');
  useEffect(() => {
    let active=true, objectUrl;
    setUrl(''); setError('');
    if(asset?.status==='completed') presentationApi.mediaContent(presentationId,asset.id).then(blob=>{
      objectUrl=URL.createObjectURL(blob); if(active)setUrl(objectUrl);else URL.revokeObjectURL(objectUrl);
    }).catch(e=>{if(active)setError(errorMessage(e));});
    return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[presentationId,asset?.id,asset?.status]);
  if(error)return <p role="alert">Không tải được bản xem trước: {error}</p>;
  if(!url)return <p className="gp-muted">Đang tải bản xem trước…</p>;
  return asset.kind==='video' ? <video src={url} controls playsInline preload="metadata" aria-label={`Video trang ${asset.slideIndex+1}`}/> : <img src={url} alt={`Ảnh minh họa trang ${asset.slideIndex+1}: ${asset.slideTitle}`}/>;
}
export default function SlideMediaPanel({ presentation, canCreate, onSelectionChange, onPendingChange }) {
  const [enabled,setEnabled]=useState(false), [assets,setAssets]=useState([]), [choices,setChoices]=useState({}), [placements,setPlacements]=useState({}), [prompts,setPrompts]=useState({}), [busyIndex,setBusyIndex]=useState(null), [error,setError]=useState('');
  const active=useRef(true); const polling=useRef(false);
  const [designing,setDesigning]=useState(false),[reasons,setReasons]=useState({}),[planMessage,setPlanMessage]=useState('');
  const outlineRef=useRef(presentation.outline);outlineRef.current=presentation.outline;
  const [batch,setBatch]=useState({running:false,done:0,total:0,failures:[]});
  const stopBatch=useRef(false);
  useEffect(()=>{
    active.current=true;
    presentationApi.listMedia(presentation._id).then(rows=>{if(active.current)setAssets(rows);}).catch(e=>{if(active.current)setError(errorMessage(e));});
    return ()=>{active.current=false;stopBatch.current=true;};
  },[presentation._id]);
  const matching=(index,kind)=>assets.find(a=>a.slideIndex===index&&a.kind===kind&&a.matchesImageRules!==false&&(a.placement||'auto')===(placements[index]||'auto')&&a.slideTitle===presentation.outline[index].title.trim()&&a.slideContent===presentation.outline[index].content.trim()&&(!prompts[index]?.trim()||a.prompt===prompts[index].trim()));
  const selected=presentation.outline.map((_,i)=>matching(i,choices[i])).filter(Boolean);
  const pending=enabled && (batch.running || busyIndex!==null || selected.some(a=>['creating','queued','processing'].includes(a.status)));
  const blocked=enabled && (batch.running || busyIndex!==null || presentation.outline.some((_,index)=>choices[index] && matching(index,choices[index])?.status!=='completed'));
  const selectedIds=enabled?selected.filter(a=>a.status==='completed').map(a=>a.id):[];
  useEffect(()=>{onSelectionChange(selectedIds);onPendingChange(blocked);},[JSON.stringify(selectedIds),blocked,onSelectionChange,onPendingChange]);
  useEffect(()=>{
    const waiting=assets.filter(a=>a.status==='creating'||a.kind==='video'&&['queued','processing'].includes(a.status));
    if(!waiting.length)return;
    const timer=setInterval(async()=>{
      if(polling.current)return; polling.current=true;
      try {
        const updates=await Promise.all(waiting.map(a=>presentationApi.refreshMedia(presentation._id,a.id)));
        if(active.current){setAssets(rows=>rows.map(a=>updates.find(u=>u.id===a.id)||a));setError('');}
      }catch(e){if(active.current)setError(errorMessage(e));}finally{polling.current=false;}
    },10000);
    return ()=>clearInterval(timer);
  },[presentation._id,assets]);
  async function generate(index) {
    setBusyIndex(index);setError('');
    try {
      const asset=await presentationApi.createMedia(presentation._id,{outline:presentation.outline,slideIndex:index,kind:choices[index],placement:placements[index]||'auto',...(prompts[index]?.trim()?{prompt:prompts[index].trim()}:{})});
      if(active.current)setAssets(rows=>[asset,...rows.filter(a=>a.id!==asset.id)]);
    }catch(e){if(active.current)setError(errorMessage(e));}finally{if(active.current)setBusyIndex(null);}
  }
  async function generateAll() {
    const outline=structuredClone(presentation.outline),snapshot=JSON.stringify(outline);
    const jobs=outline.map((_,index)=>({index,kind:choices[index],placement:placements[index]||'auto',prompt:prompts[index]?.trim(),asset:matching(index,choices[index])})).filter(job=>job.kind);
    stopBatch.current=false;setError('');setBatch({running:true,done:0,total:jobs.length,failures:[]});
    let done=0;const failures=[];
    try {
      for(const job of jobs) {
        if(!active.current||stopBatch.current)break;
        if(snapshot!==JSON.stringify(outlineRef.current)){failures.push('Nội dung trang đã đổi. Đã dừng lượt tạo; hãy kiểm tra kế hoạch lại.');break;}
        setBusyIndex(job.index);
        try {
          // Reuse completed assets and submitted video jobs; never issue a duplicate paid request.
          if(!job.asset||job.asset.status==='failed') {
            const asset=await presentationApi.createMedia(presentation._id,{outline,slideIndex:job.index,kind:job.kind,placement:job.placement,...(job.prompt?{prompt:job.prompt}:{})});
            if(active.current)setAssets(rows=>[asset,...rows.filter(a=>a.id!==asset.id)]);
          }
        }catch(e){failures.push(`Slide ${job.index+1}: ${errorMessage(e)}`);}
        done++;
        if(active.current)setBatch({running:true,done,total:jobs.length,failures:[...failures]});
      }
    }finally {
      if(active.current){setBusyIndex(null);setBatch({running:false,done,total:jobs.length,failures});}
    }
  }
  function choose(index,kind) {
    if(kind && !choices[index] && Object.values(choices).filter(Boolean).length>=20){setError('Chỉ chọn tối đa 20 slide có minh họa mỗi bản xuất.');return;}
    setChoices(prev=>({...prev,[index]:kind}));
    setPlacements(prev=>({...prev,[index]:'auto'}));
    setReasons(prev=>({...prev,[index]:''}));
  }
  async function autoDesign() {
    const snapshot=JSON.stringify(presentation.outline);
    setDesigning(true);setError('');setPlanMessage('');
    try {
      const plan=await presentationApi.suggestMedia(presentation._id,presentation.outline);
      if(!active.current)return;
      if(snapshot!==JSON.stringify(outlineRef.current)){setError('Nội dung trang đã đổi trong lúc AI phân tích. Hãy lấy đề xuất lại.');return;}
      setChoices(Object.fromEntries(plan.slides.map(s=>[s.slideIndex,s.kind==='none'?'':s.kind])));
      setPlacements(Object.fromEntries(plan.slides.map(s=>[s.slideIndex,s.placement||'auto'])));
      setPrompts(Object.fromEntries(plan.slides.map(s=>[s.slideIndex,s.prompt])));
      setReasons(Object.fromEntries(plan.slides.map(s=>[s.slideIndex,s.reason])));
      setPlanMessage('Đã áp dụng đề xuất AI. Kiểm tra kế hoạch rồi bấm Tạo toàn bộ minh họa; hệ thống sẽ thực hiện lần lượt.');
    }catch(e){if(active.current)setError(errorMessage(e));}finally{if(active.current)setDesigning(false);}
  }
  return <section className="presentation-card slide-media-panel">
    <div className="card-heading"><div><span className="eyebrow">Minh họa tùy chọn</span><h2>Bạn muốn thêm ảnh hoặc video?</h2><p className="gp-muted">Có thể tải PowerPoint chỉ gồm nội dung. Bật minh họa khi cần và chọn từng trang.</p></div><Checkbox id="slide-media-enabled" label="Thêm minh họa" checked={enabled} disabled={batch.running} onChange={e=>setEnabled(e.target.checked)}/></div>
    {enabled&&<><p className="media-cost-note">Tạo ảnh hoặc video có thể phát sinh chi phí. Mỗi trang đính kèm tối đa một nội dung minh họa; mỗi bản xuất hỗ trợ tối đa 20 nội dung.</p>
    <div className="media-ai-design"><Button onClick={autoDesign} loading={designing} disabled={!canCreate||busyIndex!==null||batch.running}>Tự thiết kế theo đề xuất AI</Button><Button onClick={generateAll} loading={batch.running} disabled={!canCreate||designing||busyIndex!==null||!Object.values(choices).some(Boolean)}>Tạo toàn bộ minh họa theo kế hoạch</Button>{batch.running&&<Button variant="ghost" onClick={()=>{stopBatch.current=true;}}>Dừng sau slide hiện tại</Button>}</div>
    <p className="gp-muted media-cost-note">Tạo lần lượt ảnh/video đã chọn; bỏ qua minh họa có sẵn. Video tiếp tục xử lý nền và tự cập nhật khi hoàn tất.</p>
    {batch.total>0&&<div className="media-batch-progress" role="status"><p>{batch.running?`Đang xử lý trang ${(busyIndex??0)+1}`:'Đã xử lý'} · {batch.done}/{batch.total} yêu cầu minh họa{!batch.running&&batch.done<batch.total?' · Đã dừng':''}</p><progress value={batch.done} max={batch.total} aria-label="Tiến độ tạo minh họa"/>{batch.failures.map((message,index)=><p className="media-status--failed" key={index}>{message}</p>)}</div>}
    {planMessage&&<p className="media-position" role="status">{planMessage}</p>}
    {error&&<p className="presentation-alert" role="alert">{error}</p>}
    <div className="media-slide-list">{presentation.outline.map((slide,index)=>{
      const kind=choices[index]||'';const asset=matching(index,kind);
      const outdated=assets.some(a=>a.slideIndex===index&&a.kind===kind&&a.matchesImageRules!==false)&&!asset;
      return <article className="media-slide-card" key={index}>
        <div className="media-slide-heading"><span className="slide-number">{String(index+1).padStart(2,'0')}</span><h3>{slide.title}</h3><Select id={`media-kind-${index}`} label="Minh họa" value={kind} disabled={busyIndex===index||designing||batch.running} onChange={e=>choose(index,e.target.value)}><option value="">Không đính kèm</option><option value="image">Ảnh do AI tạo</option><option value="video">Video do AI tạo</option></Select></div>
        {reasons[index]&&<p className="media-ai-reason">AI đề xuất: {reasons[index]}</p>}
        {kind&&<div className="media-slide-body"><div><p className="media-slide-context">{slide.content}</p><Select id={`media-placement-${index}`} label="Cách đặt minh họa" value={placements[index]||'auto'} disabled={batch.running||designing} onChange={e=>setPlacements(prev=>({...prev,[index]:e.target.value}))}><option value="auto">AI quyết định khi xuất</option>{kind==='image'&&<option value="background">Ảnh nền toàn slide</option>}<option value="left">Bên trái</option><option value="right">Bên phải</option><option value="top">Vùng phía trên</option><option value="accent">Điểm nhấn nhỏ</option></Select><Textarea id={`media-prompt-${index}`} label="Mô tả minh họa (tùy chọn)" value={prompts[index]||''} disabled={batch.running||designing} maxLength={4500} rows={3} placeholder="Để trống để tạo theo nội dung slide. Có thể mô tả cảnh, phong cách hoặc chuyển động camera." onChange={e=>setPrompts(prev=>({...prev,[index]:e.target.value}))}/><p className="media-position">Slide {index+1} · {PLACEMENT_LABEL[placements[index]||'auto']} · {kind==='video'?'Video phát khi bấm':'Ảnh giữ đúng tỷ lệ'}</p>
          {outdated&&<p className="media-cost-note">Nội dung, mô tả hoặc vị trí đã đổi. Cần tạo lại minh họa cho trang này.</p>}
          {kind==='image'&&assets.some(a=>a.slideIndex===index&&a.kind==='image'&&a.matchesImageRules===false)&&!asset&&<p className="media-cost-note">Ảnh cũ chưa áp dụng bộ quy tắc ánh sáng và màu sắc mới. Bấm tạo để cập nhật.</p>}
          <Button onClick={()=>generate(index)} loading={busyIndex===index} disabled={batch.running||designing||!canCreate||busyIndex!==null||selectedIds.length>=20&&!asset||asset&&['queued','processing','creating'].includes(asset.status)}>{asset?.status==='failed'?'Thử tạo lại':asset?.status==='completed'?'Tạo / dùng lại minh họa':'Tạo '+(kind==='video'?'video':'ảnh')}</Button>
          {asset&&<p className={`media-status media-status--${asset.status}`} role="status">Slide {index+1}: {STATUS[asset.status]}{asset.kind==='video'&&Number.isFinite(asset.progress)?` · ${asset.progress}%`:''}{asset.error&&` — ${asset.error}`}</p>}
        </div><div className="media-preview">{asset?.status==='completed'?<MediaPreview presentationId={presentation._id} asset={asset}/>:<div className="media-preview-placeholder"><b>{kind==='video'?'Video':'Ảnh'} · Trang {index+1}</b><span>{asset?STATUS[asset.status]:'Bản xem trước sẽ xuất hiện ở đây'}</span></div>}</div></div>}
      </article>;
    })}</div><p className="media-summary" role="status">{selectedIds.length} minh họa sẵn sàng đính kèm.{pending?' Video/ảnh đang tạo; chờ hoàn tất hoặc chọn Không đính kèm để tải bản khác.':blocked?' Cần tạo các minh họa đã chọn hoặc chọn Không đính kèm.':' Hãy xem trước trước khi tải PowerPoint.'}</p></>}
  </section>;
}
