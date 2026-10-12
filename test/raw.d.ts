// Vite raw imports (used to load the demo CSV files inside workerd tests).
declare module "*?raw" {
	const content: string;
	export default content;
}
