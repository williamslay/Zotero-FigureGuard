#!/usr/bin/env python3
"""Inspect top-level PDF XObject placements for the bundled PipeBWrite fixture.

Dependencies: pip install pypdf pymupdf
Scope: diagnostic script for the fixture; not a production Figure detector.
Uses pypdf to parse the PDF page content stream (not regex) and tracks q/Q/cm/Do.
Does not recurse into nested Form XObjects or resolve arbitrary graphics clipping.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from pypdf import PdfReader
from pypdf.generic import ContentStream
import fitz

IDENTITY = (1., 0., 0., 1., 0., 0.)

def mul(a, b):
    """PDF affine composition: CTM <- CTM * matrix."""
    a0, a1, a2, a3, a4, a5 = a
    b0, b1, b2, b3, b4, b5 = b
    return (a0*b0+a2*b1, a1*b0+a3*b1,
            a0*b2+a2*b3, a1*b2+a3*b3,
            a0*b4+a2*b5+a4, a1*b4+a3*b5+a5)

def point(m, x, y):
    return (m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5])

def rect(m, b):
    x0,y0,x1,y1 = [float(x) for x in b]
    pts = [point(m,x,y) for x,y in ((x0,y0),(x1,y0),(x1,y1),(x0,y1))]
    return [min(v[0] for v in pts),min(v[1] for v in pts),max(v[0] for v in pts),max(v[1] for v in pts)]

def scan(pdf_path:Path, page_index=4):
    reader = PdfReader(str(pdf_path))
    p = reader.pages[page_index]
    md = p.mediabox
    page_height = float(md.top) - float(md.bottom)
    xobjects = p['/Resources'].get('/XObject',{})
    ops = ContentStream(p['/Contents'],reader).operations
    ctm = IDENTITY
    stack = []
    out=[]
    for args,op in ops:
        if op == b'q': stack.append(ctm)
        elif op == b'Q':
            if not stack: raise RuntimeError('q/Q graphics-state imbalance')
            ctm=stack.pop()
        elif op == b'cm':
            ctm=mul(ctm,tuple(float(x) for x in args))
        elif op == b'Do':
            key=args[0]
            if key not in xobjects: continue
            obj_ref=xobjects.raw_get(key)
            xo=obj_ref.get_object()
            subtype=str(xo.get('/Subtype'))
            # Image XObjects use unit square with x/y dimensions normalized;
            # for Form XObjects use their declared BBox and optional /Matrix.
            if subtype == '/Form' and '/BBox' in xo:
                fm=tuple(float(x) for x in xo.get('/Matrix', IDENTITY))
                user_box=rect(mul(ctm,fm),xo['/BBox'])
            elif subtype == '/Image':
                user_box=rect(ctm,[0,0,1,1])
            else: continue
            # Exact top-left conversion here relies on the fixture's
            # zero rotation and full-page CropBox == MediaBox.
            top_box=[user_box[0], page_height-user_box[3],user_box[2],page_height-user_box[1]]
            out.append(dict(name=str(key),subtype=subtype,xref=obj_ref.idnum,
                            bbox_local=[float(x) for x in xo.get('/BBox',[])],
                            ctm=[round(v,6) for v in ctm],
                            bbox_pdf_user=[round(v,4) for v in user_box],
                            bbox_page_top_left=[round(v,4) for v in top_box]))
    if stack: raise RuntimeError('Unclosed q graphics state')
    doc=fitz.open(pdf_path)
    fitzpage=doc[page_index]
    captions={phrase: [[round(v,3) for v in r] for r in fitzpage.search_for(phrase)]
              for phrase in ('Figure 2:', 'Figure 3:')}
    return dict(pdf_filename=pdf_path.name,sha256=hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
                page_index=page_index,page_number=page_index+1,
                page_size=[float(fitzpage.rect.width),float(fitzpage.rect.height)],
                page_rotation=fitzpage.rotation,has_struct_tree='/StructTreeRoot' in reader.trailer['/Root'],
                image_xobjects_count=len(fitzpage.get_images(full=True)),
                xobjects=out,captions_top_left=captions,
                note='Top-left conversion is fixture-specific; plug-in must use actual PDF.js viewport for CropBox/rotation/UserUnit.')

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('pdf',type=Path)
    parser.add_argument('--page',type=int,default=5,help='1-based PDF page number, default=5')
    parser.add_argument('--out',type=Path)
    args=parser.parse_args()
    result=scan(args.pdf,args.page-1)
    output=json.dumps(result,indent=2,ensure_ascii=False)
    if args.out:
        args.out.parent.mkdir(parents=True,exist_ok=True)
        args.out.write_text(output+'\n',encoding='utf-8')
    print(output)

if __name__=='__main__':main()
