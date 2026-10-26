// Lucide icons (ISC licence, https://lucide.dev), shadcn/ui's default icon set, rendered as
// inline SVG on the server: SVG markup is fine under the strict CSP, only style= is not.
// Import icons by name from "lucide" here, so the bundle only contains the ones in use.
import { jsx } from "hono/jsx";
import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	ArrowUpDown,
	Ban,
	Barcode,
	BookOpen,
	Box,
	Boxes,
	BrickWall,
	Calendar,
	CalendarClock,
	ChartColumn,
	ChartLine,
	ChartNetwork,
	Check,
	ChevronLeft,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	CircleDollarSign,
	CirclePlus,
	CircleX,
	ClipboardCheck,
	ClipboardList,
	Clock,
	Cog,
	Coins,
	Copy,
	Database,
	DoorOpen,
	Download,
	DraftingCompass,
	Ellipsis,
	ExternalLink,
	Eye,
	Factory,
	File,
	FileDown,
	FileJson,
	FileSpreadsheet,
	FileText,
	FileUp,
	Filter,
	Flag,
	Grid2x2,
	Hammer,
	Hash,
	History,
	Image,
	ImageOff,
	ImageUp,
	Inbox,
	Info,
	Languages,
	Layers,
	LayoutDashboard,
	List,
	ListChecks,
	ListTree,
	Lock,
	Mail,
	Map as MapIcon,
	MapPin,
	Maximize,
	Minimize,
	Monitor,
	Moon,
	Package,
	PackageCheck,
	PackageOpen,
	PackagePlus,
	PanelLeft,
	Paperclip,
	Pencil,
	Phone,
	Play,
	Plus,
	Printer,
	Receipt,
	RotateCcw,
	Rows3,
	Save,
	Scale,
	Search,
	Send,
	ShieldCheck,
	ShoppingCart,
	Sigma,
	SquareDashed,
	Sun,
	SwatchBook,
	Tag,
	Timer,
	Trash2,
	TrendingDown,
	TrendingUp,
	TriangleAlert,
	Truck,
	Undo2,
	Upload,
	UserPlus,
	Users,
	Wallet,
	Warehouse,
	Wrench,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide";
import { cn } from "../lib/cn";

/** Lucide's icon data: a list of [tag, attributes] for the SVG children. */
export type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][];

export const icons = {
	brickWall: BrickWall,
	doorOpen: DoorOpen,
	flag: Flag,
	rows3: Rows3,
	squareDashed: SquareDashed,
	grid2x2: Grid2x2,
	archive: Archive,
	archiveRestore: ArchiveRestore,
	arrowDown: ArrowDown,
	arrowLeft: ArrowLeft,
	arrowUp: ArrowUp,
	arrowUpDown: ArrowUpDown,
	ban: Ban,
	barcode: Barcode,
	bookOpen: BookOpen,
	box: Box,
	boxes: Boxes,
	calendar: Calendar,
	calendarClock: CalendarClock,
	chartColumn: ChartColumn,
	chartLine: ChartLine,
	check: Check,
	chevronLeft: ChevronLeft,
	chevronRight: ChevronRight,
	circleAlert: CircleAlert,
	circleCheck: CircleCheck,
	circleDollarSign: CircleDollarSign,
	circlePlus: CirclePlus,
	circleX: CircleX,
	clipboardCheck: ClipboardCheck,
	clipboardList: ClipboardList,
	clock: Clock,
	cog: Cog,
	coins: Coins,
	copy: Copy,
	database: Database,
	diagram: ChartNetwork,
	draftingCompass: DraftingCompass,
	download: Download,
	ellipsis: Ellipsis,
	externalLink: ExternalLink,
	eye: Eye,
	factory: Factory,
	file: File,
	fileDown: FileDown,
	fileJson: FileJson,
	fileSpreadsheet: FileSpreadsheet,
	fileText: FileText,
	fileUp: FileUp,
	filter: Filter,
	hammer: Hammer,
	hash: Hash,
	history: History,
	image: Image,
	imageOff: ImageOff,
	imageUp: ImageUp,
	inbox: Inbox,
	info: Info,
	languages: Languages,
	layers: Layers,
	layoutDashboard: LayoutDashboard,
	list: List,
	listChecks: ListChecks,
	listTree: ListTree,
	lock: Lock,
	mail: Mail,
	maximize: Maximize,
	minimize: Minimize,
	monitor: Monitor,
	moon: Moon,
	package: Package,
	packageCheck: PackageCheck,
	packageOpen: PackageOpen,
	map: MapIcon,
	mapPin: MapPin,
	packagePlus: PackagePlus,
	panelLeft: PanelLeft,
	paperclip: Paperclip,
	pencil: Pencil,
	phone: Phone,
	play: Play,
	plus: Plus,
	printer: Printer,
	receipt: Receipt,
	rotateCcw: RotateCcw,
	save: Save,
	scale: Scale,
	search: Search,
	send: Send,
	shieldCheck: ShieldCheck,
	shoppingCart: ShoppingCart,
	sigma: Sigma,
	sun: Sun,
	/** Part options (D183). */
	options: SwatchBook,
	tag: Tag,
	timer: Timer,
	trash: Trash2,
	trendingDown: TrendingDown,
	trendingUp: TrendingUp,
	triangleAlert: TriangleAlert,
	truck: Truck,
	undo: Undo2,
	upload: Upload,
	userPlus: UserPlus,
	users: Users,
	wallet: Wallet,
	warehouse: Warehouse,
	wrench: Wrench,
	x: X,
	zoomIn: ZoomIn,
	zoomOut: ZoomOut,
} satisfies Record<string, IconNode>;

/**
 * An icon. Decorative by default (aria-hidden); pass `label` when it is the only content of a
 * control. Inside a Button, set `data-icon="inline-start"` (shadcn convention); size comes from
 * the parent component, so only add a size class for standalone icons.
 */
export function Icon(props: { icon: IconNode; class?: string; label?: string; "data-icon"?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={cn("lucide shrink-0", props.class)}
			aria-hidden={props.label ? undefined : "true"}
			aria-label={props.label}
			role={props.label ? "img" : undefined}
			data-icon={props["data-icon"]}
		>
			{props.icon.map(([tag, attrs]) => jsx(tag, attrs))}
		</svg>
	);
}

/** A Lucide glyph drawn inside another SVG (e.g. a diagram), `size` px square at (x, y). */
export function IconGlyph(props: { icon: IconNode; x: number; y: number; size: number; class?: string }) {
	return (
		<g
			transform={`translate(${props.x} ${props.y}) scale(${props.size / 24})`}
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={props.class}
		>
			{props.icon.map(([tag, attrs]) => jsx(tag, attrs))}
		</g>
	);
}
