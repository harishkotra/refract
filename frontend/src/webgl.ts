// Raw WebGL2 only. Fullscreen triangle via gl_VertexID, no buffers.
export const VERT = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface CompileResult {
  ok: boolean; program: WebGLProgram | null; log: string; status: 'COMPILED' | 'FAILED';
}

export function compileProgram(gl: WebGL2RenderingContext, fragSrc: string): CompileResult {
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, VERT); gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    return { ok: false, program: null, log: 'VERTEX: ' + gl.getShaderInfoLog(vs), status: 'FAILED' };
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, fragSrc); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    return { ok: false, program: null, log: (gl.getShaderInfoLog(fs) || '(empty info log)'), status: 'FAILED' };
  }
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    return { ok: false, program: null, log: (gl.getProgramInfoLog(prog) || '(empty link log)'), status: 'FAILED' };
  }
  return { ok: true, program: prog, log: '', status: 'COMPILED' };
}

export function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w, h };
}
