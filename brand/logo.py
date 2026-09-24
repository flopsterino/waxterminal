# The WAX Terminal mark: a wedge cut from a wheel of cheese, seen from above,
# with HOLE's black hole in its top. Built as a real 3D solid and projected,
# so the perspective is exact rather than drawn by eye.
import math
YAW, PITCH = math.radians(24), math.radians(44)
R, T, SPAN = 100, 30, math.radians(54)     # wheel radius, thickness, slice angle
ROT = math.radians(-200)                    # which way the tip points
def rot(p):
    x,y,z=p
    x1=x*math.cos(YAW)+z*math.sin(YAW); z1=-x*math.sin(YAW)+z*math.cos(YAW)
    y2=y*math.cos(PITCH)-z1*math.sin(PITCH); z2=y*math.sin(PITCH)+z1*math.cos(PITCH)
    return (x1,-y2,z2)
def toward(n): return rot(n)[2]
sub=lambda a,b:tuple(i-j for i,j in zip(a,b)); add=lambda a,b:tuple(i+j for i,j in zip(a,b)); mul=lambda a,k:tuple(i*k for i in a)
def cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def norm(a): l=math.sqrt(sum(i*i for i in a)); return mul(a,1/l)
N=28
arc=[ROT+SPAN*i/N for i in range(N+1)]
top=[(0,T,0)]+[(R*math.cos(a),T,R*math.sin(a)) for a in arc]
bot=[(0,0,0)]+[(R*math.cos(a),0,R*math.sin(a)) for a in arc]
cutA=[top[0],bot[0],bot[1],top[1]]           # the two cut faces
cutB=[top[0],top[-1],bot[-1],bot[0]]
rind=[[top[i],top[i+1],bot[i+1],bot[i]] for i in range(1,N+1)]
pts=[rot(p)[:2] for p in top+bot]
mnx=min(p[0] for p in pts);mxx=max(p[0] for p in pts);mny=min(p[1] for p in pts);mxy=max(p[1] for p in pts)
S=86/max(mxx-mnx,mxy-mny);OX=48-(mnx+mxx)/2*S;OY=48-(mny+mxy)/2*S
def P(p): x,y,_=rot(p); return (x*S+OX,y*S+OY)
def path(ps): return 'M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in map(P,ps))+' Z'
CEN=tuple(sum(c)/len(top+bot) for c in zip(*(top+bot)))
def vis(face):
    n=norm(cross(sub(face[1],face[0]),sub(face[2],face[0])))
    fc=tuple(sum(c)/len(face) for c in zip(*face))
    if sum(i*j for i,j in zip(n,sub(fc,CEN)))<0: n=mul(n,-1)   # outward
    return toward(n)
def frame(o,u,v):
    po=P(o);pu=P(add(o,u));pv=P(add(o,v))
    return f'matrix({pu[0]-po[0]:.4f} {pu[1]-po[1]:.4f} {pv[0]-po[0]:.4f} {pv[1]-po[1]:.4f} {po[0]:.3f} {po[1]:.3f})'

# the hole sits on the top face, on the slice's bisector
mid=ROT+SPAN/2
HC=(R*0.60*math.cos(mid),T,R*0.60*math.sin(mid))
HR=17; DEPTH=4.4
U=(1,0,0); V=(0,0,1); DOWN=(0,-1,0)
m_top=frame(HC,U,V); m_floor=frame(add(HC,mul(DOWN,DEPTH)),U,V)
smalls=[(0.26,-0.20,3.4),(0.84,0.27,4.4),(0.80,-0.30,2.6)]
def small_c(fr,off,rad):
    a=mid+off; return (R*fr*math.cos(a),T,R*fr*math.sin(a)),rad

def arm(a0,Rr):
    o=[];i_=[];n=48
    for k in range(n+1):
        t=k/n; r=Rr*(0.97-0.8*t); ang=a0+math.radians(290)*t; w=Rr*(0.19*(1-t)**1.25+0.012)
        o.append(((r+w/2)*math.cos(ang),(r+w/2)*math.sin(ang))); i_.append(((r-w/2)*math.cos(ang),(r-w/2)*math.sin(ang)))
    return 'M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in o+i_[::-1])+' Z'

def build(mode):
    col = mode=='colour'
    TOP,CUT,RIND = ('#FFD46E','#F2AE35','#D9841C') if col else ('#000',)*3
    defs=[];out=[]
    # holes are cut out of the top face
    hm=f'<circle r="{HR}" transform="{m_top}"/>'
    for fr,off,rad in smalls:
        c,r=small_c(fr,off,rad); hm+=f'<circle r="{r}" transform="{frame(c,U,V)}"/>'
    defs.append(f'<mask id="t"><rect width="96" height="96" fill="#fff"/><g fill="#000">{hm}</g></mask>')
    sep='' if col else ' stroke="#fff" stroke-width="1.4" stroke-linejoin="round"'
    if col:
        defs.append('<linearGradient id="rg" x1="0" x2="1"><stop offset="0" stop-color="#E8952A"/><stop offset="1" stop-color="#B96A12"/></linearGradient>')
    # rind: one path through the visible segments
    segs=[f for f in rind if vis(f)>0]
    if segs:
        top_edge=[f[0] for f in segs]+[segs[-1][1]]; bot_edge=[f[3] for f in segs]+[segs[-1][2]]
        out.append(f'<path d="{path(top_edge+bot_edge[::-1])}" fill="{"url(#rg)" if col else RIND}"{sep}/>')
    for j,f in enumerate((cutA,cutB)):
        if vis(f)<=0: continue
        apex_b=f[1] if f is cutA else f[3]; rim_b=f[2]
        u=norm(sub(rim_b,apex_b)); v=(0,1,0)
        L=math.dist(apex_b,rim_b)
        fh=[(0.55,0.52,4.2),(0.80,0.30,2.8)]
        mk=''.join(f'<circle r="{r}" transform="{frame(add(apex_b,add(mul(u,L*a),mul(v,T*b))),u,v)}"/>' for a,b,r in fh)
        defs.append(f'<mask id="c{j}"><rect width="96" height="96" fill="#fff"/><g fill="#000">{mk}</g></mask>')
        out.append(f'<path d="{path(f)}" fill="{CUT}" mask="url(#c{j})"{sep}/>')
        if col:
            for k,(a,b,r) in enumerate(fh):
                o=add(apex_b,add(mul(u,L*a),mul(v,T*b)))
                n_in=norm(cross(u,v)); 
                if sum(i*j2 for i,j2 in zip(n_in,sub(CEN,o)))<0: n_in=mul(n_in,-1)
                defs.append(f'<clipPath id="f{j}{k}"><circle r="{r}" transform="{frame(o,u,v)}"/></clipPath>')
                out.append(f'<g clip-path="url(#f{j}{k})"><circle r="{r}" transform="{frame(o,u,v)}" fill="#A9620F"/><circle r="{r}" transform="{frame(add(o,mul(n_in,r*0.8)),u,v)}" fill="#6E3D07"/></g>')
    out.append(f'<path d="{path(top)}" fill="{TOP}" mask="url(#t)"{sep}/>')
    if col: out.append(f'<path d="{path(top)}" fill="none" stroke="#FFE9B0" stroke-width=".7" stroke-linejoin="round" opacity=".9"/>')
    if col:
        for k,(fr,off,rad) in enumerate(smalls):
            c,r=small_c(fr,off,rad)
            defs.append(f'<clipPath id="s{k}"><circle r="{r}" transform="{frame(c,U,V)}"/></clipPath>')
            out.append(f'<g clip-path="url(#s{k})"><circle r="{r}" transform="{frame(c,U,V)}" fill="#A9620F"/><circle r="{r}" transform="{frame(add(c,mul(DOWN,r*0.7)),U,V)}" fill="#6E3D07"/></g>')
        defs.append(f'<clipPath id="hc"><circle r="{HR}" transform="{m_top}"/></clipPath>')
        defs.append(f'<radialGradient id="gl" cx="0" cy="0" r="{HR}" gradientUnits="userSpaceOnUse"><stop offset=".2" stop-color="#FFB02E" stop-opacity=".9"/><stop offset=".55" stop-color="#7A3000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>')
        arms=''.join(f'<path d="{arm(math.radians(a0),HR)}"/>' for a0 in (0,120,240))
        out.append(f'<g clip-path="url(#hc)"><circle r="{HR}" transform="{m_top}" fill="#A9620F"/>'
                   f'<circle r="{HR}" transform="{m_floor}" fill="#030303"/>'
                   f'<g transform="{m_floor}"><circle r="{HR}" fill="url(#gl)"/><g fill="#FFC44D">{arms}</g>'
                   f'<circle r="{HR*0.21:.2f}" fill="#000"/><circle r="{HR*0.21:.2f}" fill="none" stroke="#FFF0C2" stroke-width="{HR*0.045:.2f}"/></g></g>')
    else:
        arms=''.join(f'<path d="{arm(math.radians(a0),HR)}"/>' for a0 in (0,120,240))
        out.append(f'<g transform="{m_top}" fill="#000">{arms}</g>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs>{"".join(defs)}</defs>{"".join(out)}</svg>'
open('mark.svg','w').write(build('colour'))
m=build('mono'); open('mark-mono.svg','w').write(m); open('mark-ink.svg','w').write(m.replace('"#000"','"#0B0E11"'))
