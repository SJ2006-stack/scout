package app.scout.screen

/** Longest side of a saved frame. Enough to read small print; larger only costs upload and model time. */
const val FRAME_MAX_SIDE = 1600

/** JPEG qualities tried in order until the frame fits [ScreenShots.MAX_BYTES]. */
val FRAME_QUALITIES = listOf(82, 70, 55)

/** Scales [width] x [height] down so neither side passes [maxSide]. Never scales up. */
fun fitWithin(width: Int, height: Int, maxSide: Int = FRAME_MAX_SIDE): Pair<Int, Int> {
    if (width <= 0 || height <= 0) return 0 to 0
    val longest = maxOf(width, height)
    if (longest <= maxSide) return width to height
    val scale = maxSide.toDouble() / longest
    return maxOf(1, Math.round(width * scale).toInt()) to maxOf(1, Math.round(height * scale).toInt())
}

fun frameSizeFor(width: Int, height: Int, dpi: Int, maxSide: Int = FRAME_MAX_SIDE): FrameSize {
    val (fittedWidth, fittedHeight) = fitWithin(width, height, maxSide)
    return FrameSize(fittedWidth, fittedHeight, dpi)
}

/**
 * True when every sampled ARGB pixel is near black. Android blacks out windows that block
 * screenshots (banking, payment, and password screens), so such a frame is refused, not sent.
 */
fun looksBlank(pixels: IntArray): Boolean {
    if (pixels.isEmpty()) return true
    return pixels.all { pixel ->
        val red = (pixel shr 16) and 0xFF
        val green = (pixel shr 8) and 0xFF
        val blue = pixel and 0xFF
        red <= 8 && green <= 8 && blue <= 8
    }
}
