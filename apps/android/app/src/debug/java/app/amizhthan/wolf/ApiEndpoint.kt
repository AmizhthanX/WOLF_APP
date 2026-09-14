package app.amizhthan.wolf

/**
 * Debug builds talk to a WOLF API on the development machine, through the emulator's alias for it.
 * Cleartext to that host, and only to it, is allowed by the debug-only network security config.
 */
internal object ApiEndpoint {
    const val BASE_URL = "http://10.0.2.2:8080"
}
