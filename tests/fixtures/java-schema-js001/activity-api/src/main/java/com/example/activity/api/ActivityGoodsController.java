package com.example.activity.api;

import com.example.activity.model.ActivityGoodsQueryVO;
import com.example.activity.model.ActivityPageDTO;
import com.example.activity.model.GoodsFilter;
import com.example.activity.wrapper.Resp;
import com.example.activity.wrapper.TransportEnvelope;
import java.util.List;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/activity")
public class ActivityGoodsController {
  @PostMapping("/goods")
  public ActivityGoodsQueryVO direct(@RequestBody GoodsFilter filter) { return null; }

  @PostMapping("/wrapped")
  public TransportEnvelope<Resp<List<ActivityGoodsQueryVO>, String>> wrapped(
      @RequestBody GoodsFilter filter) { return null; }

  @PostMapping("/filter-envelope")
  public TransportEnvelope<GoodsFilter> filterEnvelope(@RequestBody GoodsFilter filter) { return null; }

  @PostMapping("/page")
  public ActivityPageDTO page(@RequestBody GoodsFilter filter) { return null; }
}
