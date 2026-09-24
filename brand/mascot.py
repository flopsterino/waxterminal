# The WAX Terminal mascot: a faceted mouse head whose ear openings are black
# holes. Same palette and light as the cheese mark: lit from the top left,
# gold rim light on the right from the black hole behind it.
import math
OUT='#07090B'
B,BS,BH,BHH='#3B444D','#262D34','#56616C','#6E7A86'
G,GS,GH='#F5B335','#C9851A','#FFD673'
def mirror(pts): return [(200-x,y) for x,y in pts]
def P(pts): return 'M'+' L'.join(f'{x:.1f} {y:.1f}' for x,y in pts)+' Z'
def ngon(cx,cy,r,n=8,rot=8): return [(cx+r*math.cos(math.radians(rot+360*i/n)),cy+r*math.sin(math.radians(rot+360*i/n))) for i in range(n)]
def arm(a0,R,sign=1):
    o=[];i_=[];n=44
    for k in range(n+1):
        t=k/n; r=R*(0.98-0.86*t); ang=a0+sign*math.radians(300)*t; w=R*(0.22*(1-t)**1.2+0.012)
        o.append(((r+w/2)*math.cos(ang),(r+w/2)*math.sin(ang))); i_.append(((r-w/2)*math.cos(ang),(r-w/2)*math.sin(ang)))
    return 'M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in o+i_[::-1])+' Z'

earL=ngon(46,54,44)
head=[(100,50),(134,58),(158,88),(164,118),(150,146),(124,166),(100,176),(76,166),(50,146),(36,118),(42,88),(66,58)]
defs=[f'<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter>',
      f'<clipPath id="hc"><path d="{P(head)}"/></clipPath>',
      '<clipPath id="right"><rect x="112" y="0" width="100" height="200"/></clipPath>',
      '<radialGradient id="vg" cx="0" cy="0" r="30" gradientUnits="userSpaceOnUse"><stop offset=".15" stop-color="#FFB02E" stop-opacity=".8"/><stop offset=".55" stop-color="#7A3000" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>']
out=[]
def face(pts,fill,sym=True):
    out.append(f'<path d="{P(pts)}" fill="{fill}"/>')
    if sym: out.append(f'<path d="{P(mirror(pts))}" fill="{fill}"/>')
# silhouette outline
out.append(f'<g fill="{OUT}" stroke="{OUT}" stroke-width="10" stroke-linejoin="round"><path d="{P(earL)}"/><path d="{P(mirror(earL))}"/><path d="{P(head)}"/></g>')
# ears: fur rim, then the opening — a gold accretion ring round a black hole
face(earL,BS)
face([earL[4],earL[5],earL[6],earL[7],(46,54)],BH)
def ear_hole(cx,cy,sign,cid):
    ring=ngon(cx,cy,28); inner=ngon(cx,cy,23.5); R=30
    defs.append(f'<clipPath id="{cid}"><path d="{P(inner)}"/></clipPath>')
    arms=''.join(f'<path d="{arm(math.radians(a),R,sign)}"/>' for a in (10,130,250))
    out.append(f'<path d="{P(ring)}" fill="{G}"/>'
               f'<g clip-path="url(#{cid})"><rect x="{cx-40}" y="{cy-40}" width="80" height="80" fill="#030303"/>'
               f'<g transform="translate({cx-4*sign} {cy-6})"><circle r="{R}" fill="url(#vg)"/><g fill="#FFC44D">{arms}</g>'
               f'<circle r="3.4" fill="#000"/></g></g>')
ear_hole(50,58,1,'eL'); ear_hole(150,58,-1,'eR')
# head planes
out.append(f'<path d="{P(head)}" fill="{B}"/>')
out.append(f'<path d="{P([(100,50),(66,58),(42,88),(36,118),(66,110),(100,84)])}" fill="{BH}"/>')
out.append(f'<path d="{P([(100,50),(84,56),(100,78),(116,56)])}" fill="{BHH}"/>')
out.append(f'<path d="{P([(164,118),(150,146),(124,166),(116,138),(136,112)])}" fill="{BS}"/>')
out.append(f'<path d="{P([(100,124),(118,136),(114,160),(100,172),(86,160),(82,136)])}" fill="#7C8792"/>')
out.append(f'<path d="{P([(100,124),(118,136),(114,160),(100,172)])}" fill="#66727D"/>')
face([(52,92),(94,104),(90,110),(54,100)],BS)
# eyes, glowing
eye=[(58,100),(92,110),(86,122),(64,116)]
out.append(f'<g filter="url(#glow)" opacity=".9"><path d="{P(eye)}" fill="#FFB02E"/><path d="{P(mirror(eye))}" fill="#FFB02E"/></g>')
face(eye,G); face([(58,100),(92,110),(90,114),(62,106)],GH); face([(76,105),(80,106),(79,120),(75,119)],OUT)
# nose, whiskers
out.append(f'<path d="{P([(91,158),(109,158),(100,170)])}" fill="{OUT}"/><path d="{P([(94,159),(101,159),(97,163)])}" fill="#fff" opacity=".35"/>')
for y0,y1,x1 in ((140,128,6),(146,146,2),(152,164,8)):
    out.append(f'<path d="M80 {y0} L{x1} {y1} L80 {y0+3} Z" fill="#AEB8C1"/><path d="M120 {y0} L{200-x1} {y1} L120 {y0+3} Z" fill="#AEB8C1"/>')
# rim light
out.append(f'<g clip-path="url(#right)"><g clip-path="url(#hc)"><path d="{P(head)}" fill="none" stroke="#FFC44D" stroke-width="4" stroke-linejoin="round"/></g></g>')
open('mascot.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 0 208 190"><defs>{"".join(defs)}</defs>{"".join(out)}</svg>')
