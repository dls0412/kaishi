interface CanvasApi {
  centerWorld: () => { x: number; y: number };
  viewportSize: () => { w: number; h: number };
}

export const canvasApi: CanvasApi = {
  centerWorld: () => ({ x: 0, y: 0 }),
  viewportSize: () => ({ w: 1200, h: 800 }),
};
