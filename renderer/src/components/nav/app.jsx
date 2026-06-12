import packageJson from "../../../../package.json";
import korea from "../../img/korea-sm.webp";
const APP_VERSION = packageJson.version;
const DESKTOP_DEV_MODE = window?.missionsDesktop?.desktopDevMode === true;
const ACTIVE_ICON_FILL = "url(#nav-icon-active-gradient)";

export default function NavMain({
  onOpenCli,
  onNavigate,
  currentPage,
  isCliActive,
  debugPageVisible,
}) {
  return (
    <>
      <nav id="mainNav">
        <svg
          aria-hidden="true"
          width="0"
          height="0"
          className="nav-shared-gradient"
          focusable="false"
        >
          <defs>
            <linearGradient
              id="nav-icon-active-gradient"
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="320"
              x2="640"
              y2="320"
              gradientTransform="translate(-160 0) rotate(45 320 320) scale(1.4 1)"
            >
              <stop offset="20%" stopColor="var(--color-success)" />
              <stop offset="35%" stopColor="var(--color-info)" />
              <stop offset="50%" stopColor="var(--color-primary)" />
              <stop offset="65%" stopColor="var(--color-secondary)" />
              <stop offset="80%" stopColor="var(--color-accent)" />
            </linearGradient>
          </defs>
        </svg>
        <a
          href="#"
          className={`items-center justify-center flex aspect-square w-full | text-[10px] font-thin  uppercase ${
            currentPage === "missions" ? "is-active nav-active" : ""
          }`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate?.("missions");
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 640"
            className="nav-icon"
            style={{
              fill:
                currentPage === "missions" ? ACTIVE_ICON_FILL : undefined,
            }}
          >
            <path d="M485.8 104.9L448 256L522.3 464L576 464L576 576L64 576L64 464L119.1 464L240 192L458.3 82.8L496 64L485.8 104.9zM417.9 266.8L414.6 257.7L416.9 248.3L448 123.8L264.5 215.6L154.1 464.1L272 464.1L272 432.1L224 432.1L224 400.1L272 400.1L272 352.1L304 352.1L304 400.1L352 400.1L352 432.1L304 432.1L304 464.1L488.3 464.1L417.9 266.9zM544 544L544 496L96 496L96 544L544 544zM352 240L352 256L384 256L384 288L352 288L352 320L320 320L320 288L288 288L288 256L320 256L320 224L352 224L352 240z" />
          </svg>
          Missions
        </a>
        <a
          href="#"
          className={`items-center justify-center flex aspect-square w-full | text-[10px] font-thin uppercase ${
            currentPage === "nfts" ? "is-active nav-active" : ""
          }`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate?.("nfts");
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 640"
            className="nav-icon"
            style={{ fill: currentPage === "nfts" ? ACTIVE_ICON_FILL : undefined }}
          >
            <path d="M45.5 320.1L182.9 560.1L458 560.1L595.4 320.1L458 80L182.9 80L45.5 320.1zM201.5 112L439.5 112L558.6 320.1L439.5 528.2L201.5 528.2L82.4 320.1L201.5 112zM352.9 262C351.4 263.8 328.6 292 284.5 346.7C271.7 335.9 261.8 327.6 254.8 321.8L244.5 333.4L186.1 399L178.4 407.6L184.1 417.6L215.3 472.1L219.9 480.2L420.8 480.2L425.4 472.1L457.2 416.5L462.4 407.3L456 398.9L365 278.4L352.7 262.1zM352.1 314L424.4 409.7L402.4 448.1L238.6 448.1L217.7 411.6L258.1 366.2C271.3 377.3 281.6 385.9 289 392.1L299.2 379.5L352 314zM272.5 224C272.5 232.8 265.3 240 256.5 240C247.7 240 240.5 232.8 240.5 224C240.5 215.2 247.7 208 256.5 208C265.3 208 272.5 215.2 272.5 224zM256.5 176C230 176 208.5 197.5 208.5 224C208.5 250.5 230 272 256.5 272C283 272 304.5 250.5 304.5 224C304.5 197.5 283 176 256.5 176z" />
          </svg>
          My NFTs
        </a>
        <a
          href="#"
          className={`items-center justify-center flex aspect-square w-full | text-[10px] font-thin uppercase ${
            currentPage === "rentals" ? "is-active nav-active" : ""
          }`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate?.("rentals");
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 640"
            className="nav-icon"
            style={{
              fill:
                currentPage === "rentals" ? ACTIVE_ICON_FILL : undefined,
            }}
          >
            <path d="M96 160L96 208L544 208L544 160L96 160zM96 240L96 480L544 480L544 240L96 240zM64 128L576 128L576 512L64 512L64 128zM256 416L384 416L384 320L256 320L256 416zM416 400L416 416L464 416C474.1 402.6 480 386 480 368C480 350 474.1 333.4 464 320L416 320L416 336C433.7 336 448 350.3 448 368C448 385.7 433.7 400 416 400zM192 368C192 350.3 206.3 336 224 336L224 320L176 320C165.9 333.4 160 350 160 368C160 386 165.9 402.6 176 416L224 416L224 400C206.3 400 192 385.7 192 368zM161.6 448C140.9 427.7 128 399.3 128 368C128 336.7 140.9 308.3 161.6 288L478.4 288C499.1 308.3 512 336.7 512 368C512 399.3 499.1 427.7 478.4 448L161.6 448z" />
          </svg>
          My Rentals
        </a>
        <a
          href="#"
          className={`items-center justify-center flex aspect-square w-full | text-[10px] font-thin uppercase ${
            currentPage === "mish_tish" ? "is-active nav-active" : ""
          }`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate?.("mish_tish");
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 640"
            className="nav-icon"
            style={{
              fill:
                currentPage === "mish_tish" ? ACTIVE_ICON_FILL : undefined,
            }}
          >
            <path d="M144.4 96L144.4 355.1L240.4 326.9L240.4 96L272.4 96L272.4 317.4L368.4 289.2L368.4 96L400.4 96L400.4 279.8L496.4 251.6L496.4 96L528.4 96L528.4 242.1C575.4 228.3 600.4 220.9 603.2 220.1L612.2 250.8C610.8 251.2 582.9 259.4 528.3 275.5L528.3 544L496.3 544L496.3 284.9L400.3 313.1L400.3 543.9L368.3 543.9L368.3 322.5L272.3 350.7L272.3 543.9L240.3 543.9L240.3 360.1L144.3 388.3L144.3 543.9L112.3 543.9L112.3 397.8C65.3 411.6 40.4 419 37.5 419.8L28.5 389.1C29.9 388.7 57.8 380.5 112.4 364.4L112.4 95.9L144.4 95.9z" />
          </svg>
          Mish 'tish
        </a>
        <a
          href="#"
          className={`items-center justify-center flex aspect-square w-full | text-[10px] font-thin uppercase ${
            currentPage === "stats" ? "is-active nav-active" : ""
          }`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate?.("stats");
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 640"
            className="nav-icon"
            style={{ fill: currentPage === "stats" ? ACTIVE_ICON_FILL : undefined }}
          >
            <path d="M320 544C412.5 544 491.9 488 526.1 408L560.5 408C524.6 506 430.5 576 320 576C209.5 576 115.4 506 79.5 408L113.9 408C148.1 488 227.5 544 320 544zM320 96C272.5 96 228.5 110.8 192.2 136L142 136C188.1 91.4 250.8 64 320 64C389.2 64 451.9 91.4 498 136L447.8 136C411.5 110.8 367.5 96 320 96zM320 448C362.6 448 400.3 427.2 423.6 395.2L449.5 414C420.4 454 373.3 480 320 480C266.7 480 219.5 454 190.5 414L216.4 395.2C239.7 427.3 277.4 448 320 448zM200 272C200 258.7 210.7 248 224 248C237.3 248 248 258.7 248 272C248 285.3 237.3 296 224 296C210.7 296 200 285.3 200 272zM416 248C429.3 248 440 258.7 440 272C440 285.3 429.3 296 416 296C402.7 296 392 285.3 392 272C392 258.7 402.7 248 416 248zM336 176L560 176L560 224L592 224L592 256L560 256L560 368L336 368L336 248L304 248L304 368L80 368L80 256L48 256L48 224L80 224L80 176L304 176L304 216L336 216L336 176zM528 256L528 208L368 208L368 336L528 336L528 256zM112 336L272 336L272 208L112 208L112 336z" />
          </svg>
          Stats
        </a>
        <button
          className={` items-center justify-center flex aspect-square w-full | text-[10px] font-thin uppercase ${
            isCliActive ? "is-active nav-active" : ""
          }`}
          onClick={onOpenCli}
          type="button"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 640"
            className="nav-icon"
            style={{ fill: isCliActive ? ACTIVE_ICON_FILL : undefined }}
          >
            <path d="M544 160L544 480L96 480L96 160L544 160zM96 128L64 128L64 512L576 512L576 128L96 128zM272 400L272 432L480 432L480 400L272 400zM187.3 212.7L176 201.4L153.4 224L164.7 235.3L249.4 320L164.7 404.7L153.4 416L176 438.6L187.3 427.3L283.3 331.3L294.6 320L283.3 308.7L187.3 212.7z" />
          </svg>
          CLI
        </button>
        <a
          href="#"
          className={`items-center justify-center flex aspect-square w-full | text-[10px] font-thin uppercase ${
            currentPage === "settings" ? "is-active nav-active" : ""
          }`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate?.("settings");
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 640"
            className="nav-icon"
            style={{
              fill:
                currentPage === "settings" ? ACTIVE_ICON_FILL : undefined,
            }}
          >
            <path d="M384.1 48L404.6 147.5C412.4 151.3 420 155.7 427.2 160.6L523.7 128.6L587.7 239.5L511.7 307C512.3 315.6 512.3 324.5 511.7 333L587.7 400.5L523.7 511.4L427.2 479.4C420 484.2 412.5 488.6 404.6 492.5L384.1 592L256.1 592L235.6 492.5C227.8 488.7 220.2 484.3 213 479.4L116.5 511.4L52.5 400.5L128.5 333C127.9 324.4 127.9 315.5 128.5 307L52.5 239.4L116.5 128.5L213 160.5C220.2 155.7 227.7 151.3 235.6 147.4L256.1 47.9L384.1 47.9zM437.3 191L422.4 196L409.4 187.2C403.4 183.2 397.1 179.5 390.6 176.3L376.5 169.4L373.3 154L358.1 80L282.3 80C270.1 139.1 264 168.9 263.9 169.4L249.8 176.3C243.3 179.5 237 183.1 231 187.2L218 196C217.5 195.8 188.7 186.3 131.4 167.2L93.3 232.8C138.4 272.9 161.2 293.1 161.5 293.4L160.5 309C160 316.2 160 323.6 160.5 330.8L161.5 346.4L149.8 356.8L93.3 407L131.2 472.7L202.9 448.9L217.8 443.9L230.8 452.7C236.8 456.7 243.1 460.4 249.6 463.6L263.7 470.5C263.8 471 269.9 500.7 282.1 559.9L357.9 559.9L373.1 485.9L376.3 470.5L390.4 463.6C396.9 460.4 403.2 456.8 409.2 452.7L422.2 443.9L437.1 448.9L508.8 472.7L546.7 407L490.2 356.8L478.5 346.4L479.5 330.8C480 323.6 480 316.2 479.5 309L478.5 293.4L490.2 283L546.7 232.8L508.8 167.1L437.1 190.9zM264.1 320C264.1 350.9 289.1 376 320.1 376C351 376 376 350.9 376 320C376 289.1 351 264.1 320.1 264.1C289.1 264.1 264.1 289.1 264.1 320zM320 408C271.4 408 232 368.6 232.1 320C232.1 271.3 271.5 232 320.1 232C368.7 232 408.1 271.4 408.1 320.1C408 368.7 368.6 408 320 408z" />
          </svg>
          Settings
        </a>
        {debugPageVisible ? (
          <a
            href="#"
            className={`items-center justify-center flex aspect-square w-full | text-[10px] font-thin uppercase ${
              currentPage === "debug" ? "is-active nav-active" : ""
            }`}
            onClick={(e) => {
              e.preventDefault();
              onNavigate?.("debug");
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 640 640"
              className="nav-icon"
              style={{
                fill:
                  currentPage === "debug" ? ACTIVE_ICON_FILL : undefined,
              }}
            >
              <path d="M432 32C529.2 32 608 110.8 608 208C608 276.4 569 335.6 512 364.7L512 528C512 554.5 490.5 576 464 576C437.5 576 416 554.5 416 528L416 403.6L329.8 480.2C360.1 482.5 384 507.8 384 538.6C384 559.2 367.3 575.9 346.7 575.9L176 576C131.8 576 96 540.2 96 496L96 240C96 213.5 74.5 192 48 192C39.2 192 32 184.8 32 176C32 167.2 39.2 160 48 160C92.2 160 128 195.8 128 240L128 356C156.8 304 203.2 263.1 259.2 241.3C257.1 230.5 256 219.4 256 208C256 110.8 334.8 32 432 32zM268.2 272.2C188.7 304.3 131.9 380.7 128.2 470.7L128 480L128 496C128 522.5 149.5 544 176 544L346.7 544C349.6 544 352 541.6 352 538.7C352 524 340.1 512.1 325.3 512L288 512C280.3 512 273.8 506.5 272.3 499.2L272 496L272 456C272 433.9 254.1 416 232 416L224 416C215.2 416 208 408.8 208 400C208 391.2 215.2 384 224 384L232 384C271.8 384 304 416.2 304 456L304 460.3L394.4 379.9C336.5 367.3 289.3 326.3 268.1 272.2zM480 377.3C469.7 380.2 459 382.2 448 383.2L448 528C448 536.8 455.2 544 464 544C472.8 544 480 536.8 480 528L480 377.3zM544 205.7C544 267.6 493.9 317.7 432 317.7C370.1 317.7 320 267.5 320 205.7L320 117.5C300 142.2 288 173.7 288 208C288 285 348.5 348 424.6 351.8L432 352L439.4 351.8C515.5 347.9 576 285 576 208C576 173.7 564 142.2 544 117.5L544 205.7zM469.4 149.6C466.6 151.9 463 153.1 459.4 153.1L404.5 153.1C401.8 153.1 399.1 152.4 396.7 151.1L394.5 149.6L351.9 115.5L351.9 205.7C351.9 249.9 387.7 285.7 431.9 285.7C476.1 285.7 511.9 249.9 511.9 205.7L511.9 115.5L469.3 149.6zM400 228C389 228 380 219 380 208C380 197 389 188 400 188C411 188 420 197 420 208C420 219 411 228 400 228zM464 228C453 228 444 219 444 208C444 197 453 188 464 188C475 188 484 197 484 208C484 219 475 228 464 228zM176 48C184.8 48 192 55.2 192 64L192 96L224 96C232.8 96 240 103.2 240 112C240 120.8 232.8 128 224 128L192 128L192 160C192 168.8 184.8 176 176 176C167.2 176 160 168.8 160 160L160 128L128 128C119.2 128 112 120.8 112 112C112 103.2 119.2 96 128 96L160 96L160 64C160 55.2 167.2 48 176 48zM432 64C406.5 64 382.5 70.7 361.7 82.3L410.2 121.1L453.9 121.1L502.4 82.3C481.5 70.7 457.5 64 432 64z" />
            </svg>
            Debug
          </a>
        ) : null}
        <div className="flex flex-1 w-full items-end justify-center pb-4 text-[9px] text-gray-400">
          <div className="flex flex-col items-center justify-center opacity-35 hover:opacity-80 transition-all select-none">
            <img
              src={korea}
              alt="it's a meeeee, koreaaa!"
              draggable={false}
              className="w-7/10 h-auto aspect-square "
              onDragStart={(e) => e.preventDefault()}
            />
            v{APP_VERSION}
            {DESKTOP_DEV_MODE ? (
              <span className="uppercase text-amber-300">DEV</span>
            ) : null}
          </div>
        </div>
      </nav>
    </>
  );
}
