import { useEffect, useRef, useId, useState } from 'react';
import { Modal } from '../../../components/ui/Modal';
import katex from 'katex';
import MathText from './MathText';
const SYMBOLS = ['²', '³', '√', 'π', '≤', '≥', '≠', '×', '÷', '$\\frac{a}{b}$', '$\\sqrt{x}$', '$x^{2}$'];
function read(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.dataset?.latex) return node.dataset.latex;
  if (node.nodeName === 'BR') return '\n';
  const text = [...node.childNodes].map(read).join('');
  return ['DIV', 'P'].includes(node.nodeName) && !node.classList?.contains('pt-rich-editor') && node.previousSibling ? `\n${text}` : text;
}
function formula(source) {
  const element = document.createElement('span');
  element.dataset.latex = source;
  element.contentEditable = 'false';
  element.className = 'pt-editable-formula';
  element.title = 'Bấm để sửa công thức';
  const block = source.startsWith('$$');
  element.innerHTML = katex.renderToString(source.slice(block ? 2 : 1, block ? -2 : -1), { throwOnError: false, trust: false, maxExpand: 500, maxSize: 10, displayMode: false });
  return element;
}
function fragment(text) {
  const output = document.createDocumentFragment();
  for (const piece of text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)) {
    output.append(piece.startsWith('$') && piece.endsWith('$') && piece.length > 2 ? formula(piece) : document.createTextNode(piece));
  }
  return output;
}
export default function MathEditor({ label, value, onChange, required = false, showTools = false }) {
  const editor = useRef(null); const savedRange = useRef(null); const labelId = useId();
  const editingNode = useRef(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [latex, setLatex] = useState('');
  const [formulaError, setFormulaError] = useState('');
  function openFormula(node) {
    editingNode.current = node;
    setLatex(node.dataset.latex.replace(/^\$+|\$+$/g, ''));
    setFormulaError('');
    setDialogOpen(true);
  }
  function applyFormula() {
    if (!latex.trim()) { setFormulaError('Hãy nhập công thức.'); return; }
    try { katex.renderToString(latex.trim(), { throwOnError: true, trust: false, maxExpand: 500, maxSize: 10 }); }
    catch { setFormulaError('Công thức chưa hợp lệ. Vui lòng kiểm tra dấu ngoặc và cú pháp LaTeX.'); return; }
    const node = editingNode.current;
    if (node && editor.current.contains(node)) {
      node.replaceWith(formula(`$${latex.trim()}$`));
      savedRange.current = null;
      update();
    }
    setDialogOpen(false);
  }
  useEffect(() => {
    if (editor.current && read(editor.current) !== value) editor.current.replaceChildren(fragment(value));
  }, [value]);
  const remember = () => { const selection = window.getSelection(); if (selection?.rangeCount && editor.current.contains(selection.anchorNode)) savedRange.current = selection.getRangeAt(0).cloneRange(); };
  const update = () => { remember(); onChange(read(editor.current).slice(0, 10000)); };
  function insert(text) {
    const range = savedRange.current;
    editor.current.focus();
    const target = range && editor.current.contains(range.commonAncestorContainer) ? range : document.createRange();
    if (target !== range) { target.selectNodeContents(editor.current); target.collapse(false); }
    target.deleteContents();
    const content = fragment(text); const last = content.lastChild;
    target.insertNode(content);
    if (last) target.setStartAfter(last);
    target.collapse(true); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(target); update();
  }
  return <div className="pt-field"><span id={labelId}>{label}{required ? ' *' : ''}</span>
    <div className="pt-rich-editor" ref={editor} role="textbox" aria-labelledby={labelId} aria-multiline="true" aria-required={required} contentEditable suppressContentEditableWarning onInput={update} onKeyUp={remember} onMouseUp={remember}
      onPaste={event => { event.preventDefault(); remember(); insert(event.clipboardData.getData('text/plain')); }}
      onClick={event => { const node = event.target.closest('[data-latex]'); if (node && editor.current.contains(node)) openFormula(node); }} />
    {showTools && <><div className="pt-symbols" aria-label="Chèn ký hiệu toán">{SYMBOLS.map(symbol => <button key={symbol} type="button" onMouseDown={e => e.preventDefault()} onClick={() => insert(symbol)} aria-label={`Chèn ${symbol}`}><MathText text={symbol} /></button>)}</div>
    <small className="pt-muted">Bấm ký hiệu để chèn tại con trỏ. Bấm công thức trong ô để sửa. Có thể dán công thức trong $…$.</small></>}
    <Modal open={dialogOpen} title="Sửa công thức toán" onClose={() => setDialogOpen(false)} width={560}
      footer={<div className="pt-actions"><button type="button" onClick={() => setDialogOpen(false)}>Hủy</button><button type="button" className="pt-primary" onClick={applyFormula}>Áp dụng</button></div>}>
      <label>Công thức LaTeX<input autoFocus value={latex} onChange={event => { setLatex(event.target.value); setFormulaError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyFormula(); } }} placeholder="Ví dụ: \\sqrt{x} hoặc x^{2}" maxLength={2000} /></label>
      <div className="pt-preview" style={{ marginTop: 16 }}><small>Xem trước</small><MathText text={latex.trim() ? `$${latex}$` : ''} /></div>
      {formulaError && <p className="pt-error" role="alert">{formulaError}</p>}
    </Modal>
  </div>;
}
