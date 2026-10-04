"use client"

// Silk — a flowing shader background. The GLSL is ported verbatim from React Bits
// (https://reactbits.dev, Backgrounds/Silk), but run on a raw <canvas> WebGL context
// instead of three.js / @react-three/fiber — so it adds NO dependencies and no global
// JSX augmentation, and the whole effect is a single fullscreen fragment shader.
//
// Cost: one fragment shader over a fullscreen quad, one rAF loop. It freezes on
// `prefers-reduced-motion`, pauses when the tab is hidden, and tears down on unmount —
// so it costs nothing when it isn't on screen. `color` changes ease over
// `colorTransitionMs` (set 0 to snap).
import * as React from "react"

import { cn } from "@/lib/utils"

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform vec3  uColor;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uNoiseIntensity;

const float e = 2.71828182845904523536;

float noise(vec2 texCoord) {
  float G = e;
  vec2  r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2  rot = mat2(c, -s, s, c);
  return rot * uv;
}

void main() {
  float rnd     = noise(gl_FragCoord.xy);
  vec2  uv      = rotateUvs(vUv * uScale, uRotation);
  vec2  tex     = uv * uScale;
  float tOffset = uSpeed * uTime;

  tex.y += 0.03 * sin(8.0 * tex.x - tOffset);

  float pattern = 0.6 +
                  0.4 * sin(5.0 * (tex.x + tex.y +
                                   cos(3.0 * tex.x + 5.0 * tex.y) +
                                   0.02 * tOffset) +
                           sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));

  vec4 col = vec4(uColor, 1.0) * vec4(pattern) - rnd / 15.0 * uNoiseIntensity;
  col.a = 1.0;
  gl_FragColor = col;
}
`

function hexToRGB(hex: string): [number, number, number] {
  const c = hex.replace("#", "")
  return [
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255,
  ]
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  return sh
}

export interface SilkProps {
  speed?: number
  scale?: number
  color?: string
  noiseIntensity?: number
  rotation?: number
  /** ms to ease between colors when `color` changes; 0 = snap instantly */
  colorTransitionMs?: number
  className?: string
}

export function Silk({
  speed = 5,
  scale = 1,
  color = "#7B7481",
  noiseIntensity = 1.5,
  rotation = 0,
  colorTransitionMs = 0,
  className,
}: SilkProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  // keep the latest props readable from inside the render loop without re-initializing GL
  const props = React.useRef({ speed, scale, color, noiseIntensity, rotation, colorTransitionMs })
  props.current = { speed, scale, color, noiseIntensity, rotation, colorTransitionMs }
  // lets a prop change apply + repaint immediately, even while the rAF loop is paused
  // (e.g. a background tab) — otherwise a recolor would wait for the loop to resume.
  const drawRef = React.useRef<(dtMs?: number) => void>(() => {})

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false, powerPreference: "low-power" })
    if (!gl) return

    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(program)
    gl.useProgram(program)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, "aPos")
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const u = {
      time: gl.getUniformLocation(program, "uTime"),
      color: gl.getUniformLocation(program, "uColor"),
      speed: gl.getUniformLocation(program, "uSpeed"),
      scale: gl.getUniformLocation(program, "uScale"),
      rotation: gl.getUniformLocation(program, "uRotation"),
      noise: gl.getUniformLocation(program, "uNoiseIntensity"),
    }

    // the currently displayed color, eased toward the target (props.current.color)
    const cur = hexToRGB(props.current.color)

    const applyStatic = () => {
      const p = props.current
      gl.uniform1f(u.speed, p.speed)
      gl.uniform1f(u.scale, p.scale)
      gl.uniform1f(u.rotation, p.rotation)
      gl.uniform1f(u.noise, p.noiseIntensity)
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    let time = 0
    const draw = (dtMs = 0) => {
      const p = props.current
      const tgt = hexToRGB(p.color)
      const tau = p.colorTransitionMs ?? 0
      if (tau <= 0 || document.hidden) {
        // no transition, or a paused/hidden tab where the ease loop won't run and no one
        // is watching anyway → snap so the color is correct the moment the tab is shown
        cur[0] = tgt[0]; cur[1] = tgt[1]; cur[2] = tgt[2]
      } else if (dtMs > 0) {
        // frame-rate independent ease-out; settles in roughly `tau` ms
        const a = 1 - Math.exp(-dtMs / (tau / 3))
        cur[0] += (tgt[0] - cur[0]) * a
        cur[1] += (tgt[1] - cur[1]) * a
        cur[2] += (tgt[2] - cur[2]) * a
      }
      applyStatic()
      gl.uniform3f(u.color, cur[0], cur[1], cur[2])
      gl.uniform1f(u.time, time)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    drawRef.current = draw
    draw() // paint one correct frame immediately

    let raf = 0
    let last = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const dt = last ? now - last : 16
      last = now
      if (!reduce) time += 0.1 * (dt / 1000) // matches React Bits' `uTime += 0.1 * delta`
      draw(dt)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      gl.deleteProgram(program)
      gl.deleteBuffer(buf)
      // NOTE: intentionally NOT calling loseContext() — under React StrictMode the effect
      // is mount→cleanup→mount, and losing the context here leaves the second mount with a
      // dead context (renders nothing). The context is released when the canvas unmounts.
      drawRef.current = () => {}
    }
  }, [])

  // apply + repaint immediately whenever a visual prop changes, so recolors don't wait for
  // the (possibly paused) rAF loop. Passing dt=0 lets the loop keep easing color from here.
  React.useEffect(() => {
    drawRef.current(0)
  }, [speed, scale, color, noiseIntensity, rotation, colorTransitionMs])

  return <canvas ref={canvasRef} className={cn("block size-full", className)} />
}

export default Silk
