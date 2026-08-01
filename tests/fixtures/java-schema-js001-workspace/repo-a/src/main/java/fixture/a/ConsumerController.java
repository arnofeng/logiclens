package fixture.a;
import fixture.b.SharedOrderDTO;
import org.springframework.web.bind.annotation.*;
@RestController public class ConsumerController {
  @PostMapping("/shared") public SharedOrderDTO shared(@RequestBody ConsumerInput input) { return null; }
}
