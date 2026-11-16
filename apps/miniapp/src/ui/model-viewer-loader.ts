// Движок 3D (three.js) большой - грузим его только когда он нужен, один раз на сеанс.
let loader: Promise<unknown> | null = null;

export const loadModelViewer = () => (loader ??= import('@google/model-viewer'));
